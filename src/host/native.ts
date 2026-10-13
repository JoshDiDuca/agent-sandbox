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
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativeFile('scripts', name), ...args];
}

/**
 * <storage>\bin\HostTools-<hash of its sources>.exe, compiled with the .NET Framework csc the first time; null when it
 * cannot be built (no csc, a compile error): the caller then runs the PowerShell fallback.
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
  const exe = path.join(storageRoot, 'bin', 'HostTools-' + hash.digest('hex').slice(0, 12) + '.exe');
  if (fs.existsSync(exe)) return exe;
  if (!fs.existsSync(SYSTEM.csc())) return null;
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  const result = spawnSync(SYSTEM.csc(), ['/nologo', '/optimize', '/target:exe', '/out:' + exe, ...sources], {
    windowsHide: true,
    timeout: 120000,
  });
  return result.status === 0 && fs.existsSync(exe) ? exe : null;
}
