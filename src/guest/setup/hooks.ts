// User hook scripts (.ps1 / .mjs / .js / .cmd / .bat) from hooks\<stage>, run in name order in the workspace.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exists, isWin, launchDir, log, session, warn, workspace } from '../env.js';

const commandFor = (file: string): [string, string[]] | null => {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mjs' || ext === '.js') return [process.execPath, [file]];
  if (!isWin) return null;
  if (ext === '.ps1') return ['powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file]];
  if (ext === '.cmd' || ext === '.bat') return ['cmd.exe', ['/d', '/c', file]];
  return null;
};

export const runHooks = (stage: string, env: NodeJS.ProcessEnv): void => {
  const dir = path.join(launchDir, 'hooks', stage);
  if (!exists(dir)) return;
  for (const name of fs.readdirSync(dir).sort()) {
    const command = commandFor(path.join(dir, name));
    if (!command) continue;
    log('Hook [' + stage + ']: ' + name);
    const result = spawnSync(command[0], command[1], { stdio: 'inherit', cwd: workspace, env });
    if (result.status === 0) continue;
    const message = 'Hook failed (' + stage + '/' + name + ', exit ' + result.status + ')';
    if (session.hooks.failFast) throw new Error(message);
    warn(message);
  }
};
