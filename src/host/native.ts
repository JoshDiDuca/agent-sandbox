// This package's native\ folder: HostTools.exe (native\csharp\HostTools, built here on first use) and the PowerShell
// scripts it replaces, kept as the fallback when it cannot be built.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PACKAGE_ROOT } from '../core/package-info.js';
import { SYSTEM } from '../shared/system.js';
import { refuseInSelfTest } from './test-guard.js';

const HOST_TOOLS_SOURCES = ['native', 'csharp', 'HostTools'];

/** The full path of native\<parts>. */
export function nativeFile(...parts: string[]): string {
  return path.join(PACKAGE_ROOT, 'native', ...parts);
}

/** powershell.exe arguments that run native\scripts\<name> (a .ps1 shipped next to dist) with `args`. */
export function nativeScript(name: string, args: readonly string[] = []): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-OutputFormat',
    'Text',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    nativeFile('scripts', name),
    ...args,
  ];
}

/**
 * <storage>\bin\<hash of its sources>\HostTools.exe, compiled with the .NET Framework csc the first time; null when it
 * cannot be built (no csc, a compile error): the caller then runs the PowerShell fallback. A plain name and full file
 * properties (AssemblyInfo.cs), so antivirus software does not take a nameless, random-looking exe for malware.
 */
export function hostToolsExe(storageRoot: string): string | null {
  refuseInSelfTest('build HostTools.exe');
  const dir = nativeFile(...HOST_TOOLS_SOURCES.slice(1));
  let sources: string[];
  try {
    sources = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.cs'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return null;
  }
  const hash = crypto.createHash('sha256');
  for (const file of sources) hash.update(fs.readFileSync(file));
  const bin = path.join(storageRoot, 'bin');
  const exe = path.join(bin, hash.digest('hex').slice(0, 12), 'HostTools.exe');
  if (fs.existsSync(exe)) return exe;
  if (!fs.existsSync(SYSTEM.csc())) return null;
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  removeOldHostTools(bin, path.dirname(exe));
  const result = spawnSync(SYSTEM.csc(), ['/nologo', '/optimize', '/target:exe', '/out:' + exe, ...sources], {
    windowsHide: true,
    timeout: 120000,
  });
  return result.status === 0 && fs.existsSync(exe) ? exe : null;
}

/** Earlier builds: HostTools-<hash>.exe files and other <hash> folders in bin (best effort: one in use stays). */
function removeOldHostTools(bin: string, keep: string): void {
  for (const entry of fs.readdirSync(bin, { withFileTypes: true })) {
    const full = path.join(bin, entry.name);
    const old =
      (entry.isFile() && /^HostTools-[0-9a-f]{12}\.exe$/i.test(entry.name)) ||
      (entry.isDirectory() && /^[0-9a-f]{12}$/i.test(entry.name) && full !== keep);
    if (!old) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // Still running (keep-awake of another sandbox): removed by a later build.
    }
  }
}
