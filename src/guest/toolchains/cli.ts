// Small portable command-line tools (toolchains.cli): one table entry each instead of one step per binary, plus an
// `openssl` shim onto the copy Git for Windows already ships.
import fs from 'node:fs';
import path from 'node:path';
import type { GitAccess } from '../../core/types.js';
import { dryRun, errMsg, exists, log, mkdirp, stateDir, warn, workspace } from '../env.js';
import { CLI_TOOLS, decideCli, type CliName, type CliSettings, type CliTool } from './catalogue.js';
import { arch, tool, type ToolEnv } from './common.js';
import { setupSingleExe } from './runtimes.js';
import { ensureCompiled } from '../ptyhost.js';

/** gh keeps `gh auth login` here, under the agent state (persists like Claude's own login; never copied from the PC). */
export const ghConfigDir = (): string => path.join(stateDir, 'gh');

const toolVars: Partial<Record<CliName, () => Record<string, string>>> = {
  gh: () => ({ GH_CONFIG_DIR: mkdirp(ghConfigDir()), GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' }),
};

/**
 * tools\shims\openssl.exe (sandbox/openssl.cs), a launcher for Git's mingw64\bin\openssl.exe. A real .exe so programs
 * that call CreateProcess directly (Rust's Command::new("openssl")) find it, and only the shim is on PATH: mingw64\bin
 * itself would bring Git's runtime DLLs along and could shadow MinGW's gcc from the C/C++ step.
 */
const shimOpenssl = (env: ToolEnv): void => {
  if (!exists(tool('git', 'mingw64', 'bin', 'openssl.exe'))) { env.summary.push('openssl: not in this Git for Windows (skipped)'); return; }
  const shims = mkdirp(tool('shims'));
  fs.copyFileSync(ensureCompiled('openssl'), path.join(shims, 'openssl.exe'));
  // An earlier version wrote a .cmd; it would still win for shells that prefer it.
  fs.rmSync(path.join(shims, 'openssl.cmd'), { force: true });
  env.prepend.push(shims);
  env.summary.push('openssl: Git for Windows\' copy');
};

/**
 * Installs the tools toolchains.cli asks for. Settings still "auto" here (normally the host decides) use the same
 * rules on the workspace as the host would. The gh rule is enforced here again, whatever the host sent.
 */
export const setupCli = async (env: ToolEnv, settings: CliSettings, gitAccess: GitAccess, refresh = false): Promise<void> => {
  const decisions = decideCli(settings, { gitAccess, hasGithubDir: exists(path.join(workspace, '.github')) });
  if (settings.gh && !decisions.gh.on) {
    env.summary.push('gh: off (' + decisions.gh.reason + ')');
    // A login from an earlier full-access sandbox is still on disk; the agent could read the token from there.
    if (exists(path.join(ghConfigDir(), 'hosts.yml'))) warn('gh is off (git access is not "full"), but an earlier gh login is still stored in ' + ghConfigDir() + ' and readable by the agent. Run `gh auth logout` in a full-access sandbox, or delete that folder.');
  }
  if (dryRun) { log('(dry run) would provision CLI tools: ' + Object.entries(decisions).filter(([, d]) => d.on).map(([n]) => n).join(', ')); return; }
  for (const entry of CLI_TOOLS as readonly CliTool[]) {
    const name = entry.name as CliName;
    if (!decisions[name].on) continue;
    try {
      await setupSingleExe(env, name, entry.repo, entry.asset(arch), entry.exe, tool('cli', name), { refresh, subdir: entry.subdir, size: entry.size });
      Object.assign(env.vars, toolVars[name]?.() ?? {});
    } catch (e) {
      // One tool failing never takes the others down.
      warn(name + ' could not be set up and is skipped; the other tools are not affected. Reason: ' + errMsg(e));
      env.summary.push(entry.name + ': FAILED');
    }
  }
  if (decisions.openssl.on) {
    try { shimOpenssl(env); } catch (e) { warn('openssl could not be set up and is skipped (Git Bash still has its own). Reason: ' + errMsg(e)); env.summary.push('openssl: FAILED'); }
  }
};
