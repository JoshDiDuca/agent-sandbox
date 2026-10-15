// A Claude login as files: .credentials.json plus the `oauthAccount` block of .claude.json. The sandbox's copies are
// guest-written: read without following links and size-capped; links are replaced, never written through.
import fs from 'node:fs';
import path from 'node:path';
import { assertTestWritable } from '../test-guard.js';
import { hostDataFolder, hostDataRoot } from '../storage/index.js';
import { assertNoLinks, fail, fileExists, isLink, removeLink, tryReadJson, writeJson } from '../../core/util/index.js';

export interface Login {
  readonly credentials: unknown;
  readonly oauthAccount: unknown;
}
export interface LoginFiles {
  readonly claudeDir: string;
  readonly globalStateFile: string;
}

const MAX_LOGIN_BYTES = 1024 * 1024;
/** .claude.json holds per-project state and can be large; still capped so a hostile file cannot exhaust memory. */
export const MAX_STATE_BYTES = 256 * 1024 * 1024;
/** Caches tied to an account (Claude deletes these on /logout). */
const ACCOUNT_CACHES = ['remote-settings.json', 'policy-limits.json', 'policy-limits.json.stamp.json'] as const;

export function sandboxClaudeDir(dataPath: string): string {
  return path.join(hostDataFolder(dataPath, 'state'), 'claude');
}

export function emailOf(oauthAccount: unknown): string | null {
  const email = (oauthAccount as { emailAddress?: unknown } | null)?.emailAddress;
  return typeof email === 'string' ? email.slice(0, 200) : null;
}

/** Reads a JSON file that may be sandbox-written: no links, size-capped. */
export function readUntrusted(file: string, max: number): unknown {
  return fileExists(file) && !isLink(file) && fs.statSync(file).size <= max ? tryReadJson<unknown>(file) : null;
}

/** The login currently in a Claude config folder (+ its global state file). */
export function readLogin(claudeDir: string, globalStateFile: string): Login {
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
}

/** The sandbox's Claude login files (refuses when the data folder holds a link on the way). */
export function sandboxLogin(dataPath: string): LoginFiles {
  assertNoLinks(hostDataRoot(dataPath), sandboxClaudeDir(dataPath));
  return {
    claudeDir: sandboxClaudeDir(dataPath),
    globalStateFile: path.join(sandboxClaudeDir(dataPath), '.claude.json'),
  };
}

/** Replaces a file that may be a sandbox-planted link instead of writing through it. */
export function writeSandboxJson(file: string, value: unknown): void {
  assertTestWritable(file);
  if (isLink(file)) removeLink(file);
  writeJson(file, value);
}

/** Removes the previous account's caches; otherwise its org policy could linger. A link is removed, not followed. */
export function clearAccountCaches(claudeDir: string): void {
  for (const cache of ACCOUNT_CACHES) {
    const file = path.join(claudeDir, cache);
    if (isLink(file)) removeLink(file);
    else fs.rmSync(file, { force: true });
  }
}
