// The PowerShell scripts (and the C# they load) in the package's sandbox\ folder, run by path with parameters: no
// script text is ever built in TypeScript. The folder is next to the code that runs them: <launch>\sandbox for the
// bundled guest runtime (<launch>\runtime\*.js), <package>\sandbox for the host (dist\shared\scripts.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The sandbox\ folder (boot\, scripts\ and csharp\ in it). */
export function sandboxScriptsDir(): string {
  const candidates = [path.resolve(HERE, '..', 'sandbox'), path.resolve(HERE, '..', '..', 'sandbox')];
  return (
    candidates.find((dir) => fs.existsSync(path.join(dir, 'boot', 'bootstrap.ps1'))) ??
    candidates[candidates.length - 1]
  );
}

/** powershell.exe arguments that run sandbox\scripts\<name> with `args` (5.1, no profile, never interactive). */
export function scriptArgs(name: string, args: readonly string[] = []): string[] {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(sandboxScriptsDir(), 'scripts', name),
    ...args,
  ];
}
