// Small portable command-line tools (toolchains.cli): one table entry each instead of one step per binary, plus an
// `openssl` shim onto the copy Git for Windows already ships.
import fs from 'node:fs';
import path from 'node:path';
import type { GitAccess } from '../../core/types.js';
import { dryRun, errMsg, exists, log, mkdirp, stateDir, warn, workspace } from '../env.js';
import { CLI_TOOLS, decideCli, type CliName, type CliSettings, type CliTool } from './catalogue.js';
import { arch, tool, type ToolEnv } from './common.js';
import { setupSingleExe } from './runtimes.js';

/** gh keeps `gh auth login` here, under the agent state (persists like Claude's own login; never copied from the PC). */
export const ghConfigDir = (): string => path.join(stateDir, 'gh');

const toolVars: Partial<Record<CliName, () => Record<string, string>>> = {
  gh: () => ({ GH_CONFIG_DIR: mkdirp(ghConfigDir()), GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' }),
};

/**
 * openssl.cmd in tools\shims, running Git's mingw64\bin\openssl.exe. Only the shim: putting mingw64\bin itself on PATH
 * would bring Git's own gcc-runtime DLLs, curl, and friends along and could shadow MinGW's gcc from the C/C++ step.
 * setlocal keeps OPENSSL_CONF from leaking into a cmd prompt that runs `openssl`. (A .cmd is found by shells and
 * by programs that use cmd /c; Rust's Command::new("openssl") looks only for openssl.exe.)
 */
const shimOpenssl = (env: ToolEnv): void => {
  const exe = tool('git', 'mingw64', 'bin', 'openssl.exe');
  if (!exists(exe)) { env.summary.push('openssl: not in this Git for Windows (skipped)'); return; }
  const conf = tool('git', 'mingw64', 'etc', 'ssl', 'openssl.cnf');
  const lines = ['@echo off', 'setlocal', ...(exists(conf) ? ['if not defined OPENSSL_CONF set "OPENSSL_CONF=' + conf + '"'] : []), '"' + exe + '" %*'];
  fs.writeFileSync(path.join(mkdirp(tool('shims')), 'openssl.cmd'), lines.join('\r\n') + '\r\n');
  env.prepend.push(tool('shims'));
  env.summary.push('openssl: Git for Windows\' copy (shim)');
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
      await setupSingleExe(env, name, entry.repo, entry.asset(arch), entry.exe, tool('cli', name), { refresh, subdir: entry.subdir });
      Object.assign(env.vars, toolVars[name]?.() ?? {});
    } catch (e) {
      // One tool failing never takes the others down.
      warn(name + ' setup failed (continuing without it): ' + errMsg(e));
      env.summary.push(entry.name + ': FAILED');
    }
  }
  if (decisions.openssl.on) shimOpenssl(env);
};
