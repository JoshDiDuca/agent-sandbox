import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const isWin = process.platform === 'win32';

export function fail(message/*: string*/)/*: never*/ { throw new Error(message); }
export function errMsg(e/*: unknown*/)/*: string*/ { return e instanceof Error ? e.message : String(e); }
export function ensureDir(p/*: string*/)/*: void*/ { fs.mkdirSync(p, { recursive: true }); }
export function dirExists(p/*: string*/)/*: boolean*/ { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
export function fileExists(p/*: string*/)/*: boolean*/ { try { return fs.statSync(p).isFile(); } catch { return false; } }
export function readJson/*<T>*/(p/*: string*/)/*: T*/ { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); }
export function writeJson(p/*: string*/, value/*: unknown*/)/*: void*/ { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
export function realPath(p/*: string*/)/*: string*/ { try { return fs.realpathSync(p); } catch { return p; } }
export function xmlEscape(v/*: string*/)/*: string*/ { return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

export function expandPath(input/*: string*/, base/*: string*/)/*: string*/ {
  const expanded = input.replace(/%([^%]+)%/g, (_m/*: string*/, name/*: string*/) => process.env[name] ?? '%' + name + '%');
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(base, expanded));
}
export function isRootPath(p/*: string*/)/*: boolean*/ { const n = path.resolve(p); return n.toLowerCase() === path.parse(n).root.toLowerCase(); }
export function isUserProfile(p/*: string*/)/*: boolean*/ { const profile = process.env.USERPROFILE ?? process.env.HOME ?? ''; return profile !== '' && path.resolve(p).toLowerCase() === path.resolve(profile).toLowerCase(); }

export function assertGuestPath(value/*: string*/)/*: void*/ {
  const reserved = /^C:\\(?:Windows|Program Files|Program Files \(x86\)|ProgramData|AgentLaunch|AgentData|HostTools)(?:\\|$)/i;
  if (!/^C:\\/.test(value) || value.includes('..') || value === 'C:\\' || reserved.test(value)) fail('Invalid or reserved guest path: ' + value);
}

export function findOnPath(names/*: string[]*/, excludeDirs/*: string[]*/ = [])/*: string | null*/ {
  const excluded = excludeDirs.map((d/*: string*/) => path.resolve(d).toLowerCase());
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter((d/*: string*/) => d !== '');
  for (const name of names) {
    for (const dir of dirs) {
      if (excluded.includes(path.resolve(dir).toLowerCase())) continue;
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

export function runPowerShell(script/*: string*/)/*: number*/ {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
