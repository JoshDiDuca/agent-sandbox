// Several Claude logins for the sandbox. Each account is a saved copy of Claude's .credentials.json plus the
// `oauthAccount` block of .claude.json, kept in host-only storage (<storage>\accounts, never mapped into a sandbox).
// Switching writes them into the sandbox's persistent Claude state; when the sandbox is running the agent is then
// restarted in place with --continue so the conversation carries on.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isSafeFileName } from '../../shared/paths/index.js';
import { JsonFile } from '../../shared/io/index.js';
import { storageOf } from '../storage/index.js';
import { fail, fileExists } from '../../core/util/index.js';
import {
  clearAccountCaches,
  emailOf,
  MAX_STATE_BYTES,
  readLogin,
  readUntrusted,
  sandboxLogin,
  writeSandboxJson,
  type Login,
  type LoginFiles,
} from './claude-login.js';

export interface Account {
  readonly name: string;
  readonly savedAt: string;
  readonly email: string | null;
  readonly credentials: unknown;
  readonly oauthAccount: unknown;
}
export interface AccountRow {
  readonly name: string;
  readonly email: string | null;
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly savedAt: string;
}

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const AccountSchema = z.object({
  name: z.string().regex(NAME),
  savedAt: z.string().max(64),
  email: z.string().max(200).nullable(),
  credentials: z.looseObject({}),
  oauthAccount: z.unknown(),
});
const IndexSchema = z.object({
  default: z.string().regex(NAME).optional(),
  active: z.record(z.string().max(200), z.string().regex(NAME)).optional(),
});
type Index = z.output<typeof IndexSchema>;

export function accountsDir(storageRoot: string): string {
  return path.join(storageRoot, 'accounts');
}
function dataName(dataPath: string): string {
  return path.basename(dataPath);
}
function indexFile(storageRoot: string): JsonFile<Index> {
  return new JsonFile(IndexSchema, path.join(accountsDir(storageRoot), 'index.json'));
}
function readIndex(storageRoot: string): Index {
  return indexFile(storageRoot).read() ?? {};
}
function updateIndex(storageRoot: string, change: (index: Index) => Index): void {
  indexFile(storageRoot).write(change(readIndex(storageRoot)));
}

function setActive(dataPath: string, name: string): void {
  updateIndex(storageOf(dataPath), (i) => ({ ...i, active: { ...i.active, [dataName(dataPath)]: name } }));
}

/** A file name of its own: not "index" (the index file), not a Windows device name such as con or nul. */
function validName(name: string): boolean {
  return NAME.test(name) && name.toLowerCase() !== 'index' && isSafeFileName(name + '.json');
}
function assertName(name: string): void {
  if (!validName(name))
    fail('Invalid account name "' + name + '".', 'Use letters, numbers, - and _ only (max 40), e.g. work or personal.');
}
/** The saved Claude logins under <storage>\accounts, and which one each sandbox data folder uses. */
export class AccountStore {
  constructor(private readonly storageRoot: string) {}

  private file(name: string): JsonFile<Account> {
    return new JsonFile(AccountSchema as z.ZodType<Account>, path.join(accountsDir(this.storageRoot), name + '.json'));
  }

  private store(name: string, login: Login): Account {
    const account: Account = { name, savedAt: new Date().toISOString(), email: emailOf(login.oauthAccount), ...login };
    this.file(name).write(account);
    return account;
  }

  read(name: string): Account | null {
    return validName(name) ? this.file(name).read() : null;
  }

  defaultName(): string | null {
    return readIndex(this.storageRoot).default ?? null;
  }

  /** The account a data folder uses (kept in the index of the storage folder that data folder is in). */
  activeFor(dataPath: string): string | null {
    return readIndex(storageOf(dataPath)).active?.[dataName(dataPath)] ?? null;
  }

  list(dataPath: string): AccountRow[] {
    const dir = accountsDir(this.storageRoot);
    if (!fs.existsSync(dir)) return [];
    const def = this.defaultName();
    const active = this.activeFor(dataPath);
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => this.read(f.slice(0, -5)))
      .filter((a): a is Account => a !== null)
      .map((a) => ({
        name: a.name,
        email: a.email,
        isDefault: a.name === def,
        isActive: a.name === active,
        savedAt: a.savedAt,
      }));
  }

  /** Saves the sandbox's current login (or this PC's, with fromHost) under `name`. */
  save(dataPath: string, name: string, fromHost: LoginFiles | null): Account {
    assertName(name);
    const source = fromHost ?? sandboxLogin(dataPath);
    const account = this.store(name, readLogin(source.claudeDir, source.globalStateFile));
    if (!fromHost) setActive(dataPath, name);
    if (!this.defaultName()) this.setDefault(name);
    return account;
  }

  /**
   * Makes `name` the sandbox's login. Claude refreshes (rotates) tokens while it runs, so the outgoing account's
   * current tokens are saved back first; otherwise its stored refresh token could already be invalid.
   */
  activate(dataPath: string, name: string): Account {
    const account =
      this.read(name) ??
      fail(
        'Unknown account "' + name + '".',
        'Saved accounts: ' +
          (this.list(dataPath)
            .map((a) => a.name)
            .join(', ') || 'none yet; save one with sandbox account save <name>'),
      );
    const { claudeDir, globalStateFile } = sandboxLogin(dataPath);
    const outgoing = this.activeFor(dataPath);
    if (outgoing && outgoing !== name && this.read(outgoing) && fileExists(path.join(claudeDir, '.credentials.json'))) {
      try {
        this.store(outgoing, readLogin(claudeDir, globalStateFile));
      } catch {
        /* nothing usable to save back */
      }
    }
    fs.mkdirSync(claudeDir, { recursive: true });
    clearAccountCaches(claudeDir);
    writeSandboxJson(path.join(claudeDir, '.credentials.json'), account.credentials);
    const state = readUntrusted(globalStateFile, MAX_STATE_BYTES) as Record<string, unknown> | null;
    if (account.oauthAccount && (state || !fileExists(globalStateFile)))
      writeSandboxJson(globalStateFile, { ...(state ?? {}), oauthAccount: account.oauthAccount });
    setActive(dataPath, name);
    return account;
  }

  setDefault(name: string | null): void {
    if (name !== null && !this.read(name))
      fail('Unknown account "' + name + '".', 'See your accounts with: sandbox account list');
    updateIndex(this.storageRoot, (i) => ({ ...i, default: name ?? undefined }));
  }

  rename(name: string, to: string): void {
    assertName(to);
    const account =
      this.read(name) ?? fail('Unknown account "' + name + '".', 'See your accounts with: sandbox account list');
    if (this.read(to)) fail('There is an account "' + to + '" already.', 'Pick another name.');
    this.file(to).write({ ...account, name: to });
    fs.rmSync(this.file(name).file);
    updateIndex(this.storageRoot, (i) => ({
      ...i,
      default: i.default === name ? to : i.default,
      active: Object.fromEntries(Object.entries(i.active ?? {}).map(([k, n]) => [k, n === name ? to : n])),
    }));
  }

  remove(name: string): void {
    if (!this.read(name)) fail('Unknown account "' + name + '".', 'See your accounts with: sandbox account list');
    fs.rmSync(this.file(name).file);
    if (this.defaultName() === name) this.setDefault(null);
  }
}
