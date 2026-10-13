// Builds the sandbox's small C# helpers (ptyhost.cs, gitshim.cs, vswhere.cs, openssl.cs) with the .NET Framework
// compiler that ships with Windows.
//
// The helpers are compiled onto the sandbox's own disk (wiped on close) on every boot, never cached in persistent
// storage: a tampered ptyhost.exe there would survive the wipe and see every keystroke typed from this PC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { exists, launchDir, mkdirp } from './env.js';

const CSC = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

export type Helper = 'ptyhost' | 'gitshim' | 'vswhere' | 'openssl' | 'cargoshim';

const sourceHash = (name: Helper): string => crypto.createHash('sha256').update(fs.readFileSync(path.join(launchDir, 'sandbox', name + '.cs'))).digest('hex').slice(0, 12);

/** %TEMP%\agent-sandbox\<name>-<hash>.exe, compiled from this launch's sandbox\<name>.cs the first time it is needed. */
export const ensureCompiled = (name: Helper): string => {
  const exe = path.join(os.tmpdir(), 'agent-sandbox', name + '-' + sourceHash(name) + '.exe');
  if (exists(exe)) return exe;
  if (!exists(CSC)) throw new Error('The .NET Framework C# compiler was not found at ' + CSC + ' (it ships with Windows 10/11).');
  mkdirp(path.dirname(exe));
  const result = spawnSync(CSC, ['/nologo', '/optimize', '/target:exe', '/out:' + exe, path.join(launchDir, 'sandbox', name + '.cs')], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Compiling ' + name + ' failed: ' + ((result.stdout ?? '') + (result.stderr ?? '')).trim().slice(0, 1500));
  return exe;
};
