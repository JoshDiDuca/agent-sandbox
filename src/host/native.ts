// This package's native\ folder: PowerShell scripts (and the C# they load) that the host runs by path.
import path from 'node:path';
import { PACKAGE_ROOT } from '../core/package-info.js';

/** The full path of native\<name>. */
export function nativeFile(name: string): string {
  return path.join(PACKAGE_ROOT, 'native', name);
}

/** powershell.exe arguments that run native\<name> (a .ps1 shipped next to dist) with `args`. */
export function nativeScript(name: string, args: readonly string[] = []): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativeFile(name), ...args];
}
