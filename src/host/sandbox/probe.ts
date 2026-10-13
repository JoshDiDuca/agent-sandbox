import path from 'node:path';
import type { Config, HostProbe } from '../../core/types.js';
import { dirExists, fileExists, findOnPath, homeDir, isWin, realPath } from '../../core/util/index.js';

const findHarnessExe = (config: Config, harnessName: string): HostProbe['harnessExe'] => {
  const harness = config.harnesses[harnessName];
  if (!harness?.hostExecutable) return null;
  const explicit =
    harness.hostDir && harness.hostDir !== 'auto' ? path.join(harness.hostDir, harness.hostExecutable) : null;
  const found = explicit
    ? fileExists(explicit)
      ? explicit
      : null
    : (findOnPath([harness.hostExecutable]) ??
      [path.join(homeDir(), '.local', 'bin', harness.hostExecutable)].find(fileExists) ??
      null);
  if (!found) return null;
  const real = realPath(found);
  return { dir: path.dirname(real), file: path.basename(real) };
};

/** Git for Windows root (the folder with cmd\git.exe and bin\bash.exe), from git on PATH. */
const findGitRoot = (): string | null => {
  const git = findOnPath(['git.exe']);
  if (!git) return null;
  const root = path.resolve(path.dirname(realPath(git)), '..');
  return fileExists(path.join(root, 'bin', 'bash.exe')) ? root : null;
};

/** What can be copied from this PC instead of downloaded inside the sandbox. */
export const probeHost = (config: Config, harnessName: string): HostProbe => {
  const nodeDir = isWin ? path.dirname(process.execPath) : null;
  const copy = config.provisioning.copyFromHost;
  const nvmHome = process.env.NVM_HOME;
  const nvmDir = copy && nvmHome && dirExists(nvmHome) ? realPath(nvmHome) : null;
  const hasNode = (dir: string): boolean =>
    fileExists(path.join(dir, 'node.exe')) && fileExists(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  // One source for Node: nvm's copy of this version when there is one, otherwise the Node folder itself.
  const nvmNode = Boolean(nvmDir && hasNode(path.join(nvmDir, process.version)));
  return {
    nodeDir: copy && !nvmNode && nodeDir && hasNode(nodeDir) ? realPath(nodeDir) : null,
    harnessExe: copy ? findHarnessExe(config, harnessName) : null,
    gitDir: copy && config.provisioning.git.enabled ? findGitRoot() : null,
    nvmDir,
    hostNodeVersion: process.version,
    nvmNode,
    volta: Boolean(process.env.VOLTA_HOME),
    pyenv: Boolean(process.env.PYENV ?? process.env.PYENV_ROOT ?? process.env.PYENV_HOME),
  };
};
