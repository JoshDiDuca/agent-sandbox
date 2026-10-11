import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const isWin = process.platform === 'win32';

/** Typed explicitly so TypeScript narrows after calls (arrow functions need this to act as 
ever). */
export const fail: (message: string) => never = (message) => { throw new Error(message); };
export const errMsg = (e: unknown): string => e instanceof Error ? e.message : String(e);
export const ensureDir = (p: string): void => { fs.mkdirSync(p, { recursive: true }); };
export const dirExists = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
export const fileExists = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };
export const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as T;
export const tryReadJson = <T>(p: string): T | null => { try { return readJson<T>(p); } catch { return null; } };
export const writeJson = (p: string, value: unknown): void => { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8'); };
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

const RESERVED_GUEST = /^C:\\(?:Windows|Program Files|Program Files \(x86\)|ProgramData|Users|AgentLaunch|AgentData|HostTools|nvm)(?:\\|$)/i;
export const assertGuestPath = (value: string): void => {
  if (!/^C:\\/.test(value) || value.includes('..') || value === 'C:\\' || RESERVED_GUEST.test(value)) fail('Invalid or reserved guest path: ' + value);
};

export const findOnPath = (names: string[]): string | null => {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter((d: string) => d !== '');
  for (const name of names) for (const dir of dirs) { const candidate = path.join(dir, name); if (fileExists(candidate)) return candidate; }
  return null;
};

/** PowerShell arguments for a script passed encoded (no quoting issues, no progress-bar noise on stderr). */
const powerShellArgs = (script: string): string[] => {
  const encoded = Buffer.from("$ProgressPreference = 'SilentlyContinue'\n" + script, 'utf16le').toString('base64');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
};

/** Runs a PowerShell script and returns its exit code (and stdout when `capture`). */
export const runPowerShell = (script: string, capture = false): { status: number; stdout: string } => {
  const result = spawnSync('powershell.exe', powerShellArgs(script), { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};

/** Async variant (does not block the event loop), resolving with stdout. */
export const runPowerShellAsync = (script: string): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn('powershell.exe', powerShellArgs(script), { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  child.on('error', reject);
  child.on('close', () => resolve(out));
});
