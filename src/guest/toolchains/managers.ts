// Version managers people already use: Volta (Node, npm, yarn, pnpm pinned in package.json) and pyenv-win. nvm and
// the Python step still provide the default versions; these come along when the project or this PC uses them.
import fs from 'node:fs';
import path from 'node:path';
import type { Toolchains } from '../../core/types.js';
import { installArchive, latestGithubTag } from '../../shared/download.js';
import { dryRun, errMsg, execAsync, exists, log, mkdirp, session, warn } from '../env.js';
import { projectWorkspace } from '../project-context.js';
import { arch, installFromGithub, resolveCached, tool, versionOf, type ToolEnv } from './common.js';

/** The "volta" block of the workspace's package.json ({ node, npm, yarn, pnpm }), if any. */
export const voltaPins = (): Record<string, string> => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectWorkspace(), 'package.json'), 'utf8').replace(/^﻿/, '')) as { volta?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(pkg.volta ?? {}).filter((e): e is [string, string] => ['node', 'npm', 'yarn', 'pnpm'].includes(e[0]) && typeof e[1] === 'string'));
  } catch { return {}; }
};

export const wantsVolta = (setting: Toolchains['node']['volta']): boolean => setting === 'auto' ? Object.keys(voltaPins()).length > 0 || Boolean(session.hostTools.volta) : setting;
export const wantsPyenv = (setting: Toolchains['python']['pyenv']): boolean => setting === 'auto' ? Boolean(session.hostTools.pyenv) : setting;

/**
 * Volta from its portable zip. With pins, its shims go first on PATH (the project gets exactly what package.json says,
 * fetched ahead of time); without, Volta is just available and nvm's Node stays the default.
 */
export const setupVolta = async (env: ToolEnv): Promise<void> => {
  if (dryRun) { log('(dry run) would provision Volta'); return; }
  const dir = tool('volta');
  if (!exists(path.join(dir, 'volta.exe'))) {
    const pattern = arch === 'arm64' ? /^volta-[\d.]+-windows-arm64\.zip$/ : /^volta-[\d.]+-windows\.zip$/;
    await installFromGithub('volta-cli/volta', pattern, { dest: dir, what: 'Volta (~15 MB once)', locate: 'volta.exe' });
  }
  // The MSI puts these shims (copies of volta-shim.exe) next to volta.exe; the portable zip leaves that to us.
  for (const shim of ['node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg']) {
    const target = path.join(dir, shim + '.exe');
    if (!exists(target)) fs.copyFileSync(path.join(dir, 'volta-shim.exe'), target);
  }
  const home = mkdirp(tool('volta-home'));
  const shims = mkdirp(path.join(home, 'bin'));
  const vars = { VOLTA_HOME: home, VOLTA_FEATURE_PNPM: '1' };
  Object.assign(env.vars, vars);
  const pins = voltaPins();
  if (Object.keys(pins).length) env.prepend.push(dir, shims); else env.append.push(dir, shims);
  const volta = path.join(dir, 'volta.exe');
  // `volta install` fetches the pinned versions now (not on the agent's first `node`) and makes them the defaults.
  for (const [toolName, version] of Object.entries(pins)) {
    try { await execAsync(volta, ['install', toolName + '@' + version], { env: { ...process.env, ...vars }, cwd: projectWorkspace(), stdio: 'ignore' }); }
    catch (e) { warn('Volta could not install ' + toolName + '@' + version + ': ' + errMsg(e)); }
  }
  const pinned = Object.entries(pins).map(([k, v]) => k + '@' + v);
  const note = pinned.length ? ' (pins from package.json: ' + pinned.join(', ') + ')' : ' (no pins in this project; nvm\'s node is the default)';
  env.summary.push('volta: ' + versionOf(volta) + note);
};

/**
 * pyenv-win from its source archive (it ships no release assets). Its versions persist in tools\pyenv. It comes after
 * the Python step on PATH, so `python` is the sandbox's own until you `pyenv install` / `pyenv local`.
 */
export const setupPyenv = async (env: ToolEnv): Promise<void> => {
  if (dryRun) { log('(dry run) would provision pyenv-win'); return; }
  const root = tool('pyenv', 'pyenv-win');
  if (!exists(path.join(root, 'bin', 'pyenv.bat'))) {
    const tag = await resolveCached('pyenv-win', () => latestGithubTag('pyenv-win/pyenv-win'));
    log('Downloading pyenv-win ' + tag + ' (~5 MB once) ...');
    // GitHub's tag archive: no published checksum, but HTTPS from github.com for the project's own tag.
    await installArchive('https://github.com/pyenv-win/pyenv-win/archive/refs/tags/' + encodeURIComponent(tag) + '.zip', root, { locate: 'pyenv.bat', up: 1, fileName: 'pyenv-win.zip' });
  }
  const home = root + path.sep;
  Object.assign(env.vars, { PYENV: home, PYENV_ROOT: home, PYENV_HOME: home });
  env.append.push(path.join(root, 'bin'), path.join(root, 'shims'));
  env.summary.push('pyenv-win: pyenv install <version> / pyenv local <version> (versions persist)');
};
