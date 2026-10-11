// Getting the agent (claude, codex, gemini, opencode, aider, ...) into persistent storage and working out how to start it.
import fs from 'node:fs';
import path from 'node:path';
import type { Harness } from '../../core/types.js';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, exec, exists, hostToolsDir, isWin, log, mkdirp, session, toolsDir, warn } from '../env.js';

const harnessPaths = (name: string, harness: Harness) => {
  const dir = path.join(toolsDir, 'agents', name);
  const exe = harness.hostExecutable ?? (harness.uvBin ? harness.uvBin + '.exe' : null);
  return { dir, exe: exe ? path.join(dir, exe) : null, cmd: harness.npmBin ? path.join(dir, harness.npmBin + '.cmd') : null };
};

/** npm install with the runner's own npm into tools\agents\<name> (no global state outside persistent storage). */
const installViaNpm = (name: string, harness: Harness, dir: string, env: NodeJS.ProcessEnv): void => {
  if (!harness.npmPackage) throw new Error('No npmPackage configured for ' + name + ' and no host executable was available.');
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = [npmCli, 'install', '--global', '--prefix', dir, harness.npmPackage, '--no-fund', '--no-audit'];
  log('Installing ' + harness.npmPackage + ' (this can take a minute)...');
  if (dryRun) { log('(dry run) ' + process.execPath + ' ' + args.join(' ')); return; }
  if (!exists(npmCli)) throw new Error('npm not found at ' + npmCli);
  exec(process.execPath, args, { env });
};

/** `uv tool install` with its command put straight into tools\agents\<name> (Python agents such as aider). */
const installViaUv = (name: string, harness: Harness, dir: string, env: NodeJS.ProcessEnv): void => {
  const uv = path.join(toolsDir, 'uv', 'uv.exe');
  log('Installing ' + harness.uvPackage + ' with uv (this can take a minute)...');
  if (dryRun) { log('(dry run) uv tool install ' + harness.uvPackage); return; }
  if (!exists(uv)) throw new Error(name + ' is installed with uv; enable toolchains.uv');
  exec(uv, ['tool', 'install', '--force', '--python', '3.12', harness.uvPackage!], { env: { ...env, UV_TOOL_BIN_DIR: dir, UV_TOOL_DIR: path.join(toolsDir, 'uv-tools'), UV_PYTHON_INSTALL_DIR: path.join(toolsDir, 'uv-python'), UV_CACHE_DIR: path.join(toolsDir, 'uv-cache') } });
};

/** Copies the agent from this PC when it was mapped in (primary agent only), otherwise installs it with npm or uv. */
export const provisionHarness = (name: string, harness: Harness, env: NodeJS.ProcessEnv, refresh = session.provisioning.refresh): void => {
  const p = harnessPaths(name, harness);
  const cached = (p.exe !== null && exists(p.exe)) || (p.cmd !== null && exists(p.cmd));
  if (cached && !refresh) { log(name + ' already cached in persistent storage.'); return; }
  mkdirp(p.dir);
  if (session.provisioning.copyFromHost && harness.hostExecutable && name === session.harnessName) {
    const source = path.join(hostToolsDir, 'agents', name, harness.hostExecutable);
    if (exists(source) && p.exe) { fs.copyFileSync(source, p.exe); log('Copied ' + name + ' from this PC: ' + source); return; }
    if (!session.provisioning.fallbackToInstall) throw new Error('Host copy of ' + name + ' unavailable and fallbackToInstall is false.');
    warn('Host copy of ' + name + ' not available; installing instead.');
  }
  if (harness.uvPackage && !harness.npmPackage) installViaUv(name, harness, p.dir, env);
  else installViaNpm(name, harness, p.dir, env);
};

/** Program + arguments that start the agent (an npm .cmd shim has to go through cmd.exe). */
export const resolveLaunch = (name: string, harness: Harness): { file: string; args: string[] } => {
  const p = harnessPaths(name, harness);
  if (p.exe && exists(p.exe)) return { file: p.exe, args: [] };
  if (p.cmd && exists(p.cmd)) return isWin ? { file: SYSTEM.cmd(), args: ['/d', '/c', p.cmd] } : { file: p.cmd, args: [] };
  if (dryRun) return { file: p.exe ?? p.cmd ?? name, args: [] };
  throw new Error('Cannot find an executable for ' + name + ' after provisioning.');
};
