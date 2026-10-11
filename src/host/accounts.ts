// Several Claude logins for the sandbox. Each account is a saved copy of Claude's .credentials.json plus the
// `oauthAccount` block of .claude.json, kept in host-only storage (<storage>\accounts, never mapped into a sandbox).
// Switching writes them into the sandbox's persistent Claude state; when the sandbox is running the agent is then
// restarted in place with --continue so the conversation carries on.
import fs from 'node:fs';
import path from 'node:path';
import { assertNoLinks, fail, fileExists, isLink, removeLink, tryReadJson, writeJson } from '../core/util.js';

export interface Account { name: string; savedAt: string; email: string | null; credentials: unknown; oauthAccount: unknown }
export interface AccountRow { name: string; email: string | null; isDefault: boolean; isActive: boolean; savedAt: string }
interface Index { default?: string; active?: Record<string, string> }
interface Login { credentials: unknown; oauthAccount: unknown }

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const ACCOUNT_CACHES = ['remote-settings.json', 'policy-limits.json', 'policy-limits.json.stamp.json'];
const MAX_LOGIN_BYTES = 1024 * 1024;
/** .claude.json holds per-project state and can be large; it is still capped so a hostile file cannot exhaust memory. */
const MAX_STATE_BYTES = 256 * 1024 * 1024;

export const accountsDir = (storageRoot: string): string => path.join(storageRoot, 'accounts');
export const sandboxClaudeDir = (dataPath: string): string => path.join(dataPath, 'state', 'claude');
const storageOf = (dataPath: string): string => path.dirname(path.dirname(dataPath));
const dataName = (dataPath: string): string => path.basename(dataPath);
const accountFile = (storageRoot: string, name: string): string => path.join(accountsDir(storageRoot), name + '.json');
const indexFile = (storageRoot: string): string => path.join(accountsDir(storageRoot), 'index.json');
const readIndex = (storageRoot: string): Index => tryReadJson<Index>(indexFile(storageRoot)) ?? {};
const updateIndex = (storageRoot: string, change: (index: Index) => Index): void => writeJson(indexFile(storageRoot), change(readIndex(storageRoot)));

const assertName = (name: string): void => { if (!NAME.test(name)) fail('Invalid account name "' + name + '".', 'Use letters, numbers, - and _ only (max 40), e.g. work or personal.'); };
const emailOf = (oauthAccount: unknown): string | null => {
  const email = (oauthAccount as { emailAddress?: unknown } | null)?.emailAddress;
  return typeof email === 'string' ? email.slice(0, 200) : null;
};

export const readAccount = (storageRoot: string, name: string): Account | null => (NAME.test(name) ? tryReadJson<Account>(accountFile(storageRoot, name)) : null);
export const defaultAccount = (storageRoot: string): string | null => readIndex(storageRoot).default ?? null;
export const activeAccount = (dataPath: string): string | null => readIndex(storageOf(dataPath)).active?.[dataName(dataPath)] ?? null;
const setActive = (dataPath: string, name: string): void => updateIndex(storageOf(dataPath), (i) => ({ ...i, active: { ...i.active, [dataName(dataPath)]: name } }));

export const listAccounts = (storageRoot: string, dataPath: string): AccountRow[] => {
  const dir = accountsDir(storageRoot);
  if (!fs.existsSync(dir)) return [];
  const def = defaultAccount(storageRoot);
  const active = activeAccount(dataPath);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => readAccount(storageRoot, f.slice(0, -5)))
    .filter((a): a is Account => a !== null)
    .map((a) => ({ name: a.name, email: a.email, isDefault: a.name === def, isActive: a.name === active, savedAt: a.savedAt }));
};

/** Reads a JSON file that may be sandbox-written: no links, size-capped. */
const readUntrusted = (file: string, max: number): unknown => (fileExists(file) && !isLink(file) && fs.statSync(file).size <= max ? tryReadJson<unknown>(file) : null);

/** The login currently in a Claude config folder (+ its global state file). */
const readLogin = (claudeDir: string, globalStateFile: string): Login => {
  const credentials = readUntrusted(path.join(claudeDir, '.credentials.json'), MAX_LOGIN_BYTES);
  if (!credentials || typeof credentials !== 'object') fail('No Claude login found in ' + claudeDir + '.', 'Sign in to Claude first (inside the sandbox, or on this PC with --from-host), then save it again.');
  return { credentials, oauthAccount: (readUntrusted(globalStateFile, MAX_STATE_BYTES) as { oauthAccount?: unknown } | null)?.oauthAccount ?? null };
};

const store = (storageRoot: string, name: string, login: Login): Account => {
  const account: Account = { name, savedAt: new Date().toISOString(), email: emailOf(login.oauthAccount), ...login };
  writeJson(accountFile(storageRoot, name), account);
  return account;
};

const sandboxLogin = (dataPath: string): { claudeDir: string; globalStateFile: string } => {
  assertNoLinks(dataPath, sandboxClaudeDir(dataPath));
  return { claudeDir: sandboxClaudeDir(dataPath), globalStateFile: path.join(sandboxClaudeDir(dataPath), '.claude.json') };
};

/** Saves the sandbox's current login (or this PC's, with fromHost) under `name`. */
export const saveAccount = (storageRoot: string, dataPath: string, name: string, fromHost: { claudeDir: string; globalStateFile: string } | null): Account => {
  assertName(name);
  const source = fromHost ?? sandboxLogin(dataPath);
  const account = store(storageRoot, name, readLogin(source.claudeDir, source.globalStateFile));
  if (!fromHost) setActive(dataPath, name);
  if (!defaultAccount(storageRoot)) setDefaultAccount(storageRoot, name);
  return account;
};

/** Replaces a file that may be a sandbox-planted link instead of writing through it. */
const writeSandboxJson = (file: string, value: unknown): void => {
  if (isLink(file)) removeLink(file);
  writeJson(file, value);
};

/**
 * Makes `name` the sandbox's login. Claude refreshes (rotates) tokens while it runs, so the outgoing account's
 * current tokens are saved back first; otherwise its stored refresh token could already be invalid.
 */
export const activateAccount = (storageRoot: string, dataPath: string, name: string): Account => {
  const account = readAccount(storageRoot, name) ?? fail('Unknown account "' + name + '".', 'Saved accounts: ' + (listAccounts(storageRoot, dataPath).map((a) => a.name).join(', ') || 'none yet; save one with sandbox account save <name>'));
  const { claudeDir, globalStateFile } = sandboxLogin(dataPath);
  const outgoing = activeAccount(dataPath);
  if (outgoing && outgoing !== name && readAccount(storageRoot, outgoing) && fileExists(path.join(claudeDir, '.credentials.json'))) {
    try { store(storageRoot, outgoing, readLogin(claudeDir, globalStateFile)); } catch { /* nothing usable to save back */ }
  }
  fs.mkdirSync(claudeDir, { recursive: true });
  // Caches tied to the previous account (Claude deletes these on /logout); otherwise its org policy could linger.
  for (const cache of ACCOUNT_CACHES) { const file = path.join(claudeDir, cache); if (isLink(file)) removeLink(file); else fs.rmSync(file, { force: true }); }
  writeSandboxJson(path.join(claudeDir, '.credentials.json'), account.credentials);
  const state = readUntrusted(globalStateFile, MAX_STATE_BYTES) as Record<string, unknown> | null;
  if (account.oauthAccount && (state || !fileExists(globalStateFile))) writeSandboxJson(globalStateFile, { ...(state ?? {}), oauthAccount: account.oauthAccount });
  setActive(dataPath, name);
  return account;
};

export const setDefaultAccount = (storageRoot: string, name: string | null): void => {
  if (name !== null && !readAccount(storageRoot, name)) fail('Unknown account "' + name + '".', 'See your accounts with: sandbox account list');
  updateIndex(storageRoot, (i) => ({ ...i, default: name ?? undefined }));
};

export const removeAccount = (storageRoot: string, name: string): void => {
  if (!readAccount(storageRoot, name)) fail('Unknown account "' + name + '".', 'See your accounts with: sandbox account list');
  fs.rmSync(accountFile(storageRoot, name));
  if (defaultAccount(storageRoot) === name) setDefaultAccount(storageRoot, null);
};
