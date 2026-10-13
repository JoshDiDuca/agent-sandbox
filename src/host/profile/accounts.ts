// Several Claude logins for the sandbox. Each account is a saved copy of Claude's .credentials.json plus the
// `oauthAccount` block of .claude.json, kept in host-only storage (<storage>\accounts, never mapped into a sandbox).
// Switching writes them into the sandbox's persistent Claude state; when the sandbox is running the agent is then
// restarted in place with --continue so the conversation carries on.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isSafeFileName } from '../../shared/paths/index.js';
import { assertTestWritable } from '../test-guard.js';
import { JsonFile } from '../../shared/io/index.js';
import { assertNoLinks, fail, fileExists, isLink, removeLink, tryReadJson, writeJson } from '../../core/util/index.js';

export interface Account {
  name: string;
  savedAt: string;
  email: string | null;
  credentials: unknown;
  oauthAccount: unknown;
}
export interface AccountRow {
  name: string;
  email: string | null;
  isDefault: boolean;
  isActive: boolean;
  savedAt: string;
}
interface Login {
  credentials: unknown;
  oauthAccount: unknown;
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
const ACCOUNT_CACHES = ['remote-settings.json', 'policy-limits.json', 'policy-limits.json.stamp.json'];
const MAX_LOGIN_BYTES = 1024 * 1024;
/** .claude.json holds per-project state and can be large; it is still capped so a hostile file cannot exhaust memory. */
const MAX_STATE_BYTES = 256 * 1024 * 1024;

export const accountsDir = (storageRoot: string): string => path.join(storageRoot, 'accounts');
export const sandboxClaudeDir = (dataPath: string): string => path.join(dataPath, 'state', 'claude');
const storageOf = (dataPath: string): string => path.dirname(path.dirname(dataPath));
const dataName = (dataPath: string): string => path.basename(dataPath);
const indexFile = (storageRoot: string): JsonFile<Index> =>
  new JsonFile(IndexSchema, path.join(accountsDir(storageRoot), 'index.json'));
const readIndex = (storageRoot: string): Index => indexFile(storageRoot).read() ?? {};
const updateIndex = (storageRoot: string, change: (index: Index) => Index): void => {
  indexFile(storageRoot).write(change(readIndex(storageRoot)));
};

const setActive = (dataPath: string, name: string): void =>
  updateIndex(storageOf(dataPath), (i) => ({ ...i, active: { ...i.active, [dataName(dataPath)]: name } }));

/** A file name of its own: not "index" (the index file), not a Windows device name such as con or nul. */
const validName = (name: string): boolean =>
  NAME.test(name) && name.toLowerCase() !== 'index' && isSafeFileName(name + '.json');
const assertName = (name: string): void => {
  if (!validName(name))
    fail('Invalid account name "' + name + '".', 'Use letters, numbers, - and _ only (max 40), e.g. work or personal.');
};
const emailOf = (oauthAccount: unknown): string | null => {
  const email = (oauthAccount as { emailAddress?: unknown } | null)?.emailAddress;
  return typeof email === 'string' ? email.slice(0, 200) : null;
};

/** Reads a JSON file that may be sandbox-written: no links, size-capped. */
const readUntrusted = (file: string, max: number): unknown =>
  fileExists(file) && !isLink(file) && fs.statSync(file).size <= max ? tryReadJson<unknown>(file) : null;

/** The login currently in a Claude config folder (+ its global state file). */
const readLogin = (claudeDir: string, globalStateFile: string): Login => {
  const credentials = readUntrusted(path.join(claudeDir, '.credentials.json'), MAX_LOGIN_BYTES);
  if (!credentials || typeof credentials !== 'object')
    fail(
      'No Claude login found in ' + claudeDir + '.',
      'Sign in to Claude first (inside the sandbox, or on this PC with --from-host), then save it again.',
    );
  return {
    credentials,
    oauthAccount:
      (readUntrusted(globalStateFile, MAX_STATE_BYTES) as { oauthAccount?: unknown } | null)?.oauthAccount ?? null,
  };
};

const sandboxLogin = (dataPath: string): { claudeDir: string; globalStateFile: string } => {
  assertNoLinks(dataPath, sandboxClaudeDir(dataPath));
  return {
    claudeDir: sandboxClaudeDir(dataPath),
    globalStateFile: path.join(sandboxClaudeDir(dataPath), '.claude.json'),
  };
};

/** Replaces a file that may be a sandbox-planted link instead of writing through it. */
const writeSandboxJson = (file: string, value: unknown): void => {
  assertTestWritable(file);
  if (isLink(file)) removeLink(file);
  writeJson(file, value);
};

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
  save(dataPath: string, name: string, fromHost: { claudeDir: string; globalStateFile: string } | null): Account {
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
    // Caches tied to the previous account (Claude deletes these on /logout); otherwise its org policy could linger.
    for (const cache of ACCOUNT_CACHES) {
      const file = path.join(claudeDir, cache);
      if (isLink(file)) removeLink(file);
      else fs.rmSync(file, { force: true });
    }
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

  remove(name: string): void {
    if (!this.read(name)) fail('Unknown account "' + name + '".', 'See your accounts with: sandbox account list');
    fs.rmSync(this.file(name).file);
    if (this.defaultName() === name) this.setDefault(null);
  }
}
