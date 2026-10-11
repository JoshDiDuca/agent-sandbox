import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { Config, HostProbe } from '../core/types.js';
import { SYSTEM } from '../shared/system.js';
import { dirExists, ensureDir, fail, fileExists, findOnPath, homeDir, isWin, realPath } from '../core/util.js';

const findHarnessExe = (config: Config, harnessName: string): HostProbe['harnessExe'] => {
  const harness = config.harnesses[harnessName];
  if (!harness?.hostExecutable) return null;
  const explicit = harness.hostDir && harness.hostDir !== 'auto' ? path.join(harness.hostDir, harness.hostExecutable) : null;
  const found = explicit
    ? (fileExists(explicit) ? explicit : null)
    : findOnPath([harness.hostExecutable]) ?? [path.join(homeDir(), '.local', 'bin', harness.hostExecutable)].find(fileExists) ?? null;
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
  const hasNode = (dir: string): boolean => fileExists(path.join(dir, 'node.exe')) && fileExists(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
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

const SANDBOX_PROCESSES = ['WindowsSandboxClient.exe', 'WindowsSandboxRemoteSession.exe', 'WindowsSandbox.exe'];

/**
 * Running INSIDE a Windows Sandbox this tool started (its launch folder and data folder are mapped in): then the CLI
 * talks to the sandbox it is in, through C:\\AgentData and loopback, instead of looking for one on a PC.
 */
export const insideSandbox = (): boolean => isWin && !process.env.AGENT_SANDBOX_HOST_ONLY && fs.existsSync('C:\\AgentLaunch\\session.json') && fs.existsSync('C:\\AgentData\\run');
export const GUEST_DATA_DIR = 'C:\\AgentData';

export const isSandboxRunning = (): boolean => {
  if (!isWin) return false;
  if (insideSandbox()) return true;
  const result = spawnSync(SYSTEM.tasklist(), ['/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
  const out = (result.stdout ?? '').toLowerCase();
  return SANDBOX_PROCESSES.some((image: string) => out.includes('"' + image.toLowerCase() + '"'));
};

export const sandboxFeatureInstalled = (): boolean => isWin && fileExists(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsSandbox.exe'));

export const assertCanLaunch = (): void => {
  if (!isWin) fail('Windows Sandbox only runs on Windows.', 'Use sandbox generate to only write the files.');
  if (!sandboxFeatureInstalled()) fail('Windows Sandbox is not enabled on this PC.', 'Run in an admin PowerShell, then reboot: Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All  (needs Windows Pro, Enterprise or Education)');
  if (isSandboxRunning()) fail('A Windows Sandbox is already running (Windows allows one at a time).', 'Attach to it with claude-sbx -t, show it with sbx-show, or shut it down with sandbox stop.');
};

export const startSandbox = (wsbPath: string): void => {
  const result = spawnSync(SYSTEM.cmd(), ['/d', '/c', 'start', '""', '"' + wsbPath + '"'], { stdio: 'inherit', windowsVerbatimArguments: true });
  if (result.error) throw result.error;
};

/** Runs a detached copy of this CLI (used for the background history/claude-mem sync watcher). */
export const spawnDetached = (entry: string, args: string[]): void => {
  // cwd = the install folder: the caller's folder is the workspace, which the sandbox can write.
  spawn(process.execPath, [entry, ...args], { cwd: path.dirname(entry), detached: true, stdio: 'ignore', windowsHide: true }).unref();
};

export const hostClaude = (storageRoot: string, personal: boolean, args: string[]): number => {
  const exe = findOnPath(['claude.exe', 'claude.cmd']);
  if (!exe) fail('Claude Code is not installed on this PC (no claude.exe or claude.cmd on PATH).', 'Install it: npm install -g @anthropic-ai/claude-code');
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!personal) {
    const profile = path.join(storageRoot, 'host', 'claude');
    ensureDir(profile);
    env.CLAUDE_CONFIG_DIR = profile;
    console.warn('Host Claude is NOT sandboxed. Using separate profile: ' + profile + ' (pass --personal to use your normal one).');
  }
  const result = exe.toLowerCase().endsWith('.cmd') ? spawnSync(SYSTEM.cmd(), ['/d', '/c', exe, ...args], { stdio: 'inherit', env }) : spawnSync(exe, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

export const doctorRows = (config: Config, harnessName: string, storageRoot: string, configPath: string | null): [string, string][] => {
  const probe = probeHost(config, harnessName);
  return [
    ['Config file', configPath ?? '(none; built-in defaults; create one with: sandbox config init)'],
    ['Windows', isWin ? 'yes' : 'NO (launch needs Windows)'],
    ['Windows Sandbox feature', sandboxFeatureInstalled() ? 'enabled' : 'NOT enabled'],
    ['Sandbox running', isSandboxRunning() ? 'YES' : 'no'],
    ['Free host RAM (MB)', String(Math.floor(os.freemem() / 1048576))],
    ['Provisioning', config.provisioning.copyFromHost ? 'copy from this PC' + (config.provisioning.fallbackToInstall ? ', fall back to download' : ', no fallback') : 'download inside sandbox'],
    ['Host Node (runner)', probe.nvmNode ? 'nvm ' + probe.hostNodeVersion : probe.nodeDir ?? '(none; will download)'],
    ['Host nvm versions', probe.nvmDir ?? '(no NVM_HOME; versions will be downloaded)'],
    ['Host ' + harnessName, probe.harnessExe ? path.join(probe.harnessExe.dir, probe.harnessExe.file) : '(none; will npm install)'],
    ['Host Git for Windows', probe.gitDir ?? '(none with bash; PortableGit will be downloaded)'],
    ['Storage root', storageRoot + (dirExists(storageRoot) ? '' : ' (will be created)')],
  ];
};
