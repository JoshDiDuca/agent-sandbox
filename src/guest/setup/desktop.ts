// Making the sandbox feel like your PC: desktop look and Git identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, isWin, launchDir } from '../runtime/paths.js';
import { exec, powershell } from '../runtime/process.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log } from '../runtime/log.js';
import { session } from '../runtime/session.js';

const psQuote = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

/** Imports the host's look (registry values + wallpaper) and restarts Explorer so it applies. */
export const applyPersonalization = (): void => {
  const dir = path.join(launchDir, 'personalize');
  if (!session.personalization || !exists(dir) || dryRun || !isWin) return;
  exec(SYSTEM.reg(), ['import', path.join(dir, 'personalize.reg')], { stdio: 'ignore' });
  const wallpaper = fs.readdirSync(dir).find((f) => f.startsWith('wallpaper'));
  const local = wallpaper ? path.join(mkdirp(path.join(os.homedir(), 'Pictures')), wallpaper) : null;
  if (wallpaper && local) fs.copyFileSync(path.join(dir, wallpaper), local);
  powershell(
    [
      local ? "Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name WallPaper -Value " + psQuote(local) : '',
      'Add-Type -Namespace AgentSandbox -Name Desk -MemberDefinition \'[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int SystemParametersInfo(int a, int b, string c, int d);\'',
      local ? '[void][AgentSandbox.Desk]::SystemParametersInfo(20, 0, ' + psQuote(local) + ', 3)' : '',
      // Explorer restarts by itself and picks up taskbar/theme changes.
      'Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  log('Desktop personalisation applied from this PC.');
};
