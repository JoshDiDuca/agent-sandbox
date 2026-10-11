import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { SYSTEM } from '../shared/system.js';
import { writeJsonAtomic } from '../shared/rundir.js';
import { assertTestWritable } from '../shared/test-guard.js';
import { parse as parseJsoncText, printParseErrorCode, type ParseError } from 'jsonc-parser';

export const isWin = process.platform === 'win32';

/** An expected problem the user can act on: what went wrong, and (optionally) how to fix it. */
export class UserError extends Error {
  constructor(message: string, readonly fix?: string) { super(message); this.name = 'UserError'; }
}

/** Throws a UserError. Typed explicitly so TypeScript narrows after calls (arrow functions need it to act as never). */
export const fail: (message: string, fix?: string) => never = (message, fix) => { throw new UserError(message, fix); };
/**
 * Parses JSON with comments and trailing commas (JSONC, like VS Code's settings.json). Errors name the file, line
 * and column, and say what to fix.
 */
export const parseJsonc = <T>(text: string, source: string): T => {
  const errors: ParseError[] = [];
  const value = parseJsoncText(text.replace(/^﻿/, ''), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const { offset, error } = errors[0];
    const before = text.slice(0, offset).split(/\r?\n/);
    fail(source + ' is not valid JSON (line ' + before.length + ', column ' + (before[before.length - 1].length + 1) + ': ' + printParseErrorCode(error) + ').', 'Fix that spot in the file. Comments (// and /* */) and trailing commas are fine.');
  }
  return value as T;
};

export const readJsonc = <T>(file: string): T => parseJsonc<T>(fs.readFileSync(file, 'utf8'), file);

export const errMsg =(e: unknown): string => e instanceof Error ? e.message : String(e);
export const ensureDir = (p: string): void => { fs.mkdirSync(p, { recursive: true }); };
export const dirExists = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
export const fileExists = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };
export const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as T;
export const tryReadJson = <T>(p: string): T | null => { try { return readJson<T>(p); } catch { return null; } };
/** Atomic (a crash or a second command never leaves half a file); refused outside temp during the self-test. */
export const writeJson = (p: string, value: unknown): void => writeJsonAtomic(p, value);
export const realPath = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
export const xmlEscape = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export const homeDir = (): string => process.env.USERPROFILE ?? os.homedir();
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Expands %VAR% and resolves relative paths against `base`. */
export const expandPath = (input: string, base: string): string => {
  const expanded = input.replace(/%([^%]+)%/g, (_m: string, name: string) => process.env[name] ?? '%' + name + '%').replace(/^~(?=$|[\\/])/, homeDir());
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(base, expanded));
};
export const isRootPath = (p: string): boolean => { const n = path.resolve(p); return n.toLowerCase() === path.parse(n).root.toLowerCase(); };
export const isUserProfile = (p: string): boolean => { const profile = process.env.USERPROFILE ?? process.env.HOME ?? ''; return profile !== '' && path.resolve(p).toLowerCase() === path.resolve(profile).toLowerCase(); };
export const isInsideOrEqual = (parent: string, child: string): boolean => {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Text that came from the sandbox, made safe to print: control characters and escape sequences are removed except
 * plain colours (SGR), so nothing written by the sandbox can drive your terminal (titles, clipboard, cursor tricks).
 */
export const safeText = (text: string): string =>
  text.replace(/\x1b\[[0-9;]*m|\x1b(\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (m) => (/^\x1b\[[0-9;]*m$/.test(m) ? m : ''));

export const findOnPath = (names: string[]): string | null => {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter((d: string) => d !== '');
  for (const name of names) for (const dir of dirs) { const candidate = path.join(dir, name); if (fileExists(candidate)) return candidate; }
  return null;
};

/** True if `p` itself is a symlink or junction (lstat; never follows it). */
export const isLink = (p: string): boolean => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Removes a symlink or junction itself (never its target). Junctions need rmdir on Windows. */
export const removeLink = (p: string): void => { assertTestWritable(p); try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } };

/**
 * The sandbox can write anywhere in its data folder, so it could swap a folder for a junction that points at this
 * PC's own disk. Before the host reads, writes or deletes anything under `root`, every existing path component from
 * `root` down to `target` must be a plain folder/file. Throws otherwise.
 */
export const assertNoLinks = (root: string, target: string): void => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail('Refusing to touch ' + target + ': it is outside ' + root);
  let current = path.resolve(root);
  for (const part of ['', ...rel.split(path.sep).filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    if (isLink(current)) fail('Refusing to touch ' + target + ': ' + current + ' is a link (possible escape attempt from the sandbox).');
  }
};

/**
 * PowerShell arguments for a script passed encoded (no quoting issues, no progress-bar noise on stderr). Output is
 * UTF-8: Windows PowerShell 5.1 otherwise writes redirected stdout in the OEM code page, mangling non-ASCII (regional
 * date formats, wallpaper paths). UTF8Encoding($false): no byte-order mark in front of the output.
 */
const powerShellArgs = (script: string): string[] => {
  const prelude = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n$ProgressPreference = 'SilentlyContinue'\n";
  const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
};

/** Runs a PowerShell script and returns its exit code (and stdout when `capture`). */
export const runPowerShell = (script: string, capture = false): { status: number; stdout: string } => {
  const result = spawnSync(SYSTEM.powershell(), powerShellArgs(script), { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};

/** Runs a program (an absolute path: `SYSTEM.*`, never a bare name) and returns its stdout, or '' if it failed or timed out. */
export const captureOutput = (file: string, args: string[], options: { timeout?: number; cwd?: string; maxBuffer?: number } = {}): string => {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, ...options });
  return result.status === 0 ? result.stdout ?? '' : '';
};

/** Async variant (does not block the event loop), resolving with stdout. */
export const runPowerShellAsync = (script: string): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn(SYSTEM.powershell(), powerShellArgs(script), { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  child.on('error', reject);
  child.on('close', () => resolve(out));
});
