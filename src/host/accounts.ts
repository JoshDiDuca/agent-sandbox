// Several Claude logins for the sandbox. Each account is a saved copy of Claude's .credentials.json plus the
// `oauthAccount` block of .claude.json. Switching writes them into the sandbox's persistent Claude state; when the
// sandbox is running the agent is then restarted in place with --continue so the conversation carries on.
import fs from 'node:fs';
import path from 'node:path';
import { fail, fileExists, tryReadJson, writeJson } from '../core/util.js';

export interface Account { name: string; savedAt: string; email: string | null; credentials: unknown; oauthAccount: unknown }
export interface AccountRow { name: string; email: string | null; isDefault: boolean; isActive: boolean; savedAt: string }

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const MARKER = '.agent-sandbox-account';

export const accountsDir = (storageRoot: string): string => path.join(storageRoot, 'accounts');
export const sandboxClaudeDir = (dataPath: string): string => path.join(dataPath, 'state', 'claude');
const accountFile = (storageRoot: string, name: string): string => path.join(accountsDir(storageRoot), name + '.json');
const indexFile = (storageRoot: string): string => path.join(accountsDir(storageRoot), 'index.json');

const assertName = (name: string): void => { if (!NAME.test(name)) fail('Account names may only use letters, numbers, - and _ (max 40): ' + name); };
const emailOf = (oauthAccount: unknown): string | null => (oauthAccount as { emailAddress?: string } | null)?.emailAddress ?? null;

export const readAccount = (storageRoot: string, name: string): Account | null => tryReadJson<Account>(accountFile(storageRoot, name));
export const defaultAccount = (storageRoot: string): string | null => tryReadJson<{ default?: string }>(indexFile(storageRoot))?.default ?? null;
export const activeAccount = (dataPath: string): string | null => {
  const file = path.join(sandboxClaudeDir(dataPath), MARKER);
  return fileExists(file) ? fs.readFileSync(file, 'utf8').trim() || null : null;
};

export const listAccounts = (storageRoot: string, dataPath: string): AccountRow[] => {
  const dir = accountsDir(storageRoot);
  if (!fs.existsSync(dir)) return [];
  const def = defaultAccount(storageRoot);
  const active = activeAccount(dataPath);
  return fs.readdirSync(dir)
    .filter((f: string) => f.endsWith('.json') && f !== 'index.json')
    .map((f: string) => readAccount(storageRoot, f.slice(0, -5)))
    .filter((a: Account | null): a is Account => a !== null)
    .map((a: Account) => ({ name: a.name, email: a.email, isDefault: a.name === def, isActive: a.name === active, savedAt: a.savedAt }));
};

/** Reads the login currently in a Claude config folder (+ its global state file). */
const readLogin = (claudeDir: string, globalStateFile: string): { credentials: unknown; oauthAccount: unknown } => {
  const credentials = tryReadJson<unknown>(path.join(claudeDir, '.credentials.json'));
  if (!credentials) fail('No Claude login found in ' + claudeDir + ' (sign in first, then save it).');
  return { credentials, oauthAccount: tryReadJson<{ oauthAccount?: unknown }>(globalStateFile)?.oauthAccount ?? null };
};

const store = (storageRoot: string, name: string, login: { credentials: unknown; oauthAccount: unknown }): Account => {
  const account: Account = { name, savedAt: new Date().toISOString(), email: emailOf(login.oauthAccount), ...login };
  writeJson(accountFile(storageRoot, name), account);
  return account;
};

/** Saves the sandbox's current login (or this PC's, with fromHost) under `name`. */
export const saveAccount = (storageRoot: string, dataPath: string, name: string, fromHost: { claudeDir: string; globalStateFile: string } | null): Account => {
  assertName(name);
  const source = fromHost ?? { claudeDir: sandboxClaudeDir(dataPath), globalStateFile: path.join(sandboxClaudeDir(dataPath), '.claude.json') };
  const account = store(storageRoot, name, readLogin(source.claudeDir, source.globalStateFile));
  if (!fromHost) fs.writeFileSync(path.join(sandboxClaudeDir(dataPath), MARKER), name, 'utf8');
  if (!defaultAccount(storageRoot)) setDefaultAccount(storageRoot, name);
  return account;
};

/**
 * Makes `name` the sandbox's login. Claude refreshes (rotates) tokens while it runs, so the outgoing account's
 * current tokens are saved back first; otherwise its stored refresh token could already be invalid.
 */
export const activateAccount = (storageRoot: string, dataPath: string, name: string): Account => {
  const account = readAccount(storageRoot, name);
  if (!account) fail('Unknown account "' + name + '". Saved accounts: ' + (listAccounts(storageRoot, dataPath).map((a: AccountRow) => a.name).join(', ') || '(none)'));
  const claudeDir = sandboxClaudeDir(dataPath);
  const stateFile = path.join(claudeDir, '.claude.json');
  const outgoing = activeAccount(dataPath);
  if (outgoing && outgoing !== name && readAccount(storageRoot, outgoing) && fileExists(path.join(claudeDir, '.credentials.json'))) store(storageRoot, outgoing, readLogin(claudeDir, stateFile));
  writeJson(path.join(claudeDir, '.credentials.json'), account.credentials);
  const state = tryReadJson<Record<string, unknown>>(stateFile) ?? {};
  if (account.oauthAccount) writeJson(stateFile, { ...state, oauthAccount: account.oauthAccount });
  fs.writeFileSync(path.join(claudeDir, MARKER), name, 'utf8');
  return account;
};

export const setDefaultAccount = (storageRoot: string, name: string | null): void => {
  if (name !== null && !readAccount(storageRoot, name)) fail('Unknown account "' + name + '".');
  writeJson(indexFile(storageRoot), name === null ? {} : { default: name });
};

export const removeAccount = (storageRoot: string, name: string): void => {
  if (!readAccount(storageRoot, name)) fail('Unknown account "' + name + '".');
  fs.rmSync(accountFile(storageRoot, name));
  if (defaultAccount(storageRoot) === name) setDefaultAccount(storageRoot, null);
};
