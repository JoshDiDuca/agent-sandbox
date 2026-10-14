import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { refuseInSelfTest } from '../test-guard.js';
import { fail, fileExists, isWin } from '../../core/util/index.js';
import { launchBlocked } from '../sharing/rules.js';
import type { SandboxOwner } from '../sharing/owner.js';

const SANDBOX_PROCESSES = ['WindowsSandboxClient.exe', 'WindowsSandboxRemoteSession.exe', 'WindowsSandbox.exe'];

/**
 * Running INSIDE a Windows Sandbox this tool started (its launch folder and data folder are mapped in): then the CLI
 * talks to the sandbox it is in, through C:\\AgentData and loopback, instead of looking for one on a PC.
 */
export function insideSandbox(): boolean {
  return (
    isWin &&
    !process.env.AGENT_SANDBOX_HOST_ONLY &&
    fs.existsSync('C:\\AgentLaunch\\session.json') &&
    fs.existsSync('C:\\AgentData\\run')
  );
}
export const GUEST_DATA_DIR = 'C:\\AgentData';

export function isSandboxRunning(): boolean {
  if (!isWin) return false;
  if (insideSandbox()) return true;
  const result = spawnSync(SYSTEM.tasklist(), ['/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
  const out = (result.stdout ?? '').toLowerCase();
  return SANDBOX_PROCESSES.some((image: string) => out.includes('"' + image.toLowerCase() + '"'));
}

export function sandboxFeatureInstalled(): boolean {
  return isWin && fileExists(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsSandbox.exe'));
}

/** `owner`: whose sandbox runs, when the caller knows (host/sharing); it makes the message say who started it. */
export function assertCanLaunch(owner?: SandboxOwner): void {
  if (!isWin) fail('Windows Sandbox only runs on Windows.', 'Use sandbox generate to only write the files.');
  if (!sandboxFeatureInstalled())
    fail(
      'Windows Sandbox is not enabled on this PC.',
      'Run in an admin PowerShell, then reboot: Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All  (needs Windows Pro, Enterprise or Education)',
    );
  if (isSandboxRunning()) {
    const other = owner ? launchBlocked(owner) : null;
    fail(
      other
        ? other + ' (Windows allows one per PC).'
        : 'A Windows Sandbox is already running (Windows allows one at a time).',
      other
        ? 'Use it with sandbox attach if it is shared with you, or start yours after it stops.'
        : 'Attach to it with sandbox claude -t, show it with sbx-show, or shut it down with sandbox stop.',
    );
  }
}

/** cmd.exe expands %VAR% and ^ even inside quotes, and a quote ends them: such a path could run something else. */
export function assertCmdSafePath(file: string): void {
  if (/[%"^\r\n]/.test(file))
    fail(
      'The storage folder path has a character that cannot be started safely: ' + file,
      'Set storage.root to a folder without % " ^ in its path.',
    );
}

export function startSandbox(wsbPath: string): void {
  refuseInSelfTest('start Windows Sandbox');
  assertCmdSafePath(wsbPath);
  const result = spawnSync(SYSTEM.cmd(), ['/d', '/c', 'start', '""', '"' + wsbPath + '"'], {
    stdio: 'inherit',
    windowsVerbatimArguments: true,
  });
  if (result.error) throw result.error;
}

/** Runs a detached copy of this CLI (used for the background history/claude-mem sync watcher). */
export function spawnDetached(entry: string, args: string[]): void {
  refuseInSelfTest('start background programs');
  // cwd = the install folder: the caller's folder is the workspace, which the sandbox can write.
  spawn(process.execPath, [entry, ...args], {
    cwd: path.dirname(entry),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}
