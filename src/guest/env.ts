// Shared state for the guest scripts (main, daemon, view): fixed paths, the session description, logging, status.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { moveIntoPlace, setChecksumRequired, spawnAsync, stagingFolder } from '../shared/download.js';
import type { GuestSession, SandboxStatus } from '../core/types.js';
import { now, runPaths, writeJsonAtomic } from '../shared/rundir.js';
import { safeRemove } from '../shared/safe-remove.js';
import { SYSTEM } from '../shared/system.js';

export const isWin = process.platform === 'win32';
export const dryRun = process.env.AGENT_DRY_RUN === '1';
/** Real provisioning, but nothing machine-wide (environment variables): for end-to-end tests outside a sandbox. */
export const testMode = process.env.AGENT_SANDBOX_TEST === '1';
export const launchDir = process.env.AGENT_LAUNCH_DIR ?? 'C:\\AgentLaunch';
export const dataDir = process.env.AGENT_DATA_DIR ?? 'C:\\AgentData';
export const hostToolsDir = process.env.AGENT_HOST_TOOLS_DIR ?? 'C:\\HostTools';
/** Folders that must stay on the sandbox's own disk (symlinks, SQLite) rather than in a mapped folder. */
export const localDir = process.env.AGENT_LOCAL_DIR ?? 'C:\\nvm';
export const toolsDir = path.join(dataDir, 'tools');
export const logsDir = path.join(dataDir, 'logs');
export const run = runPaths(dataDir);

export const session = JSON.parse(fs.readFileSync(path.join(launchDir, 'session.json'), 'utf8').replace(/^\uFEFF/, '')) as GuestSession;
setChecksumRequired(session.downloads?.requireChecksum === true);
export const workspace = process.env.AGENT_WORKSPACE ?? session.workspace;
export const stateDir = path.join(dataDir, session.persistAgentState ? 'state' : 'state-session');
export const claudeDir = path.join(stateDir, 'claude');

fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, (process.env.AGENT_LOG_PREFIX ?? 'guest') + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log');
const append = (line: string): void => { try { fs.appendFileSync(logFile, line + '\n'); } catch { /* logging must never break the run */ } };

export const log = (message: string): void => { console.log(message); append(message); };
export const warn = (message: string): void => { console.warn('\x1b[33mWARNING: ' + message + '\x1b[0m'); append('WARNING: ' + message); };
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const exists = (p: string): boolean => fs.existsSync(p);
export const mkdirp = (p: string): string => { fs.mkdirSync(p, { recursive: true }); return p; };
export const logPath = logFile;

/** Best-effort: progress reporting must never be what breaks the boot. */
export const setSandboxStatus = (phase: SandboxStatus['phase'], message: string): void => {
  try { writeJsonAtomicChecked(phase, message); } catch (e) { warn('Could not update sandbox status: ' + errMsg(e)); }
};

const writeJsonAtomicChecked = (phase: SandboxStatus['phase'], message: string): void => {
  writeJsonAtomic(run.sandbox, { launchId: session.launchId, phase, message, updatedAt: now(), workspaceHost: session.workspaceHost, guestWorkspace: workspace, headless: session.headless } satisfies SandboxStatus);
};

/** Runs a program, streaming output, and throws with a readable message when it fails. */
export const exec = (file: string, args: string[], options: SpawnSyncOptions = {}): void => {
  const result = spawnSync(file, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(path.basename(file) + ' ' + args.slice(0, 3).join(' ') + ' failed with exit code ' + result.status);
};

/** exec without blocking: other toolchains keep downloading while this one runs an installer. */
export const execAsync = async (file: string, args: string[], options: SpawnOptions = {}): Promise<void> => {
  const code = await spawnAsync(file, args, { stdio: 'inherit', ...options });
  if (code !== 0) throw new Error(path.basename(file) + ' ' + args.slice(0, 3).join(' ') + ' failed with exit code ' + code);
};

export const execOutput = (file: string, args: string[], options: SpawnSyncOptions = {}): string => {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, ...options });
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
};

export const powershell = (script: string): void => exec(SYSTEM.powershell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);

/** Copies a folder with robocopy (fast, restartable), or just the named files in it; exit codes below 8 mean success. */
export const robocopy = (from: string, to: string, files: string[] = []): void => {
  if (!isWin) {
    if (!files.length) { fs.cpSync(from, to, { recursive: true }); return; }
    fs.mkdirSync(to, { recursive: true });
    for (const f of files.filter((f) => fs.existsSync(path.join(from, f)))) fs.copyFileSync(path.join(from, f), path.join(to, f));
    return;
  }
  const what = files.length ? files : ['/E', '/MT:16'];
  const result = spawnSync(SYSTEM.robocopy(), [from, to, ...what, '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1', '/XJ'], { stdio: 'ignore', windowsHide: true });
  if ((result.status ?? 16) >= 8) throw new Error('robocopy ' + from + ' -> ' + to + ' failed (exit ' + result.status + ')');
};

/**
 * A Node install without its global packages (nvm keeps those per version: often tens of thousands of small files,
 * which is what made copying from this PC slow). Same file list as Copy-NodeFromHost in sandbox/bootstrap.ps1.
 * Copied into a staging folder and renamed into place: node.exe alone (an interrupted copy) must not look like a full install.
 */
export const copyNode = (from: string, to: string): void => {
  const work = stagingFolder(to);
  try {
    robocopy(from, work, ['node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd']);
    robocopy(path.join(from, 'node_modules', 'npm'), path.join(work, 'node_modules', 'npm'));
    moveIntoPlace(work, to);
  } finally { safeRemove(work, path.dirname(work)); }
};
