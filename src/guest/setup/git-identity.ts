import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dryRun, launchDir, toolsDir } from '../runtime/paths.js';
import { exists } from '../runtime/fs.js';

/**
 * Your Git identity from this PC (name/email only), plus safe.directory for the mapped workspace (its owner SID
 * differs in the sandbox). Uses the real git.exe directly: the read-only guard would rightly refuse `config --add`.
 */
export const setupGitConfig = (env: NodeJS.ProcessEnv): void => {
  // A dry run (the self-test) must not touch the real ~/.gitconfig: it once replaced the sandbox's own, safe.directory
  // included, so git refused the workspace until the next boot.
  if (dryRun) return;
  const source = path.join(launchDir, 'home', '.gitconfig');
  if (exists(source)) fs.copyFileSync(source, path.join(os.homedir(), '.gitconfig'));
  const git = path.join(toolsDir, 'git', 'cmd', 'git.exe');
  if (!exists(git)) return;
  const { GIT_DIR: _gitDir, ...rest } = env;
  spawnSync(git, ['config', '--global', '--add', 'safe.directory', '*'], {
    env: rest,
    windowsHide: true,
    stdio: 'ignore',
  });
  // Windows long paths are on in the sandbox, but git skips files over 260 characters unless told.
  spawnSync(git, ['config', '--global', 'core.longpaths', 'true'], { env: rest, windowsHide: true, stdio: 'ignore' });
  // Git for Windows' system config says autocrlf=true: checkouts made in the sandbox (worktrees, clones) got CRLF and
  // tools that want LF (rustfmt, shellcheck, prettier) failed on every file. "input" keeps the line endings the repo
  // has, and a checkout from your PC (CRLF in the folder) still shows as unchanged.
  spawnSync(git, ['config', '--global', 'core.autocrlf', 'input'], { env: rest, windowsHide: true, stdio: 'ignore' });
};
