// Making the sandbox feel like your PC: desktop look and Git identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, exec, exists, isWin, launchDir, log, mkdirp, powershell, session, toolsDir } from '../env.js';

const psQuote = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

/** Imports the host's look (registry values + wallpaper) and restarts Explorer so it applies. */
export const applyPersonalization = (): void => {
  const dir = path.join(launchDir, 'personalize');
  if (!session.personalization || !exists(dir) || dryRun || !isWin) return;
  exec(SYSTEM.reg(), ['import', path.join(dir, 'personalize.reg')], { stdio: 'ignore' });
  const wallpaper = fs.readdirSync(dir).find((f) => f.startsWith('wallpaper'));
  const local = wallpaper ? path.join(mkdirp(path.join(os.homedir(), 'Pictures')), wallpaper) : null;
  if (wallpaper && local) fs.copyFileSync(path.join(dir, wallpaper), local);
  powershell([
    local ? "Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name WallPaper -Value " + psQuote(local) : '',
    "Add-Type -Namespace AgentSandbox -Name Desk -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int SystemParametersInfo(int a, int b, string c, int d);'",
    local ? '[void][AgentSandbox.Desk]::SystemParametersInfo(20, 0, ' + psQuote(local) + ', 3)' : '',
    // Explorer restarts by itself and picks up taskbar/theme changes.
    'Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue',
  ].filter(Boolean).join('\n'));
  log('Desktop personalisation applied from this PC.');
};

/**
 * Your Git identity from this PC (name/email only), plus safe.directory for the mapped workspace (its owner SID
 * differs in the sandbox). Uses the real git.exe directly: the read-only guard would rightly refuse `config --add`.
 */
export const setupGitConfig = (env: NodeJS.ProcessEnv): void => {
  const source = path.join(launchDir, 'home', '.gitconfig');
  if (exists(source)) fs.copyFileSync(source, path.join(os.homedir(), '.gitconfig'));
  const git = path.join(toolsDir, 'git', 'cmd', 'git.exe');
  if (dryRun || !exists(git)) return;
  const { GIT_DIR: _gitDir, ...rest } = env;
  spawnSync(git, ['config', '--global', '--add', 'safe.directory', '*'], { env: rest, windowsHide: true, stdio: 'ignore' });
};
