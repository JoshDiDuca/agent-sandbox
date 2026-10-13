// Making the sandbox feel like your PC: desktop look and Git identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, isWin, launchDir } from '../runtime/paths.js';
import { exec, runScript } from '../runtime/process.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log } from '../runtime/log.js';
import { session } from '../runtime/session.js';

/** Imports the host's look (registry values + wallpaper) and restarts Explorer so it applies. */
export const applyPersonalization = (): void => {
  const dir = path.join(launchDir, 'personalize');
  if (!session.personalization || !exists(dir) || dryRun || !isWin) return;
  exec(SYSTEM.reg(), ['import', path.join(dir, 'personalize.reg')], { stdio: 'ignore' });
  const wallpaper = fs.readdirSync(dir).find((f) => f.startsWith('wallpaper'));
  const local = wallpaper ? path.join(mkdirp(path.join(os.homedir(), 'Pictures')), wallpaper) : null;
  if (wallpaper && local) fs.copyFileSync(path.join(dir, wallpaper), local);
  runScript('set-desktop.ps1', local ? ['-Wallpaper', local] : []);
  log('Desktop personalisation applied from this PC.');
};
