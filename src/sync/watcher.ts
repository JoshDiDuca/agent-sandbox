// When history and claude-mem move: in before every launch, out every minute while the sandbox runs (history) and
// once more when it closes (history + claude-mem). The watcher runs detached on the host for the sandbox's lifetime.
// Its pid file and log live in host-only storage, never in the data folder the sandbox can write.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../core/types.js';
import { writeFileAtomic } from '../shared/rundir.js';
import { refuseInSelfTest } from '../host/test-guard.js';
import { assertNoLinks, errMsg, sleep } from '../core/util.js';
import { hostClaudeDir } from '../host/claude-profile.js';
import { checkRepo } from '../host/repo-guard.js';
import { isSandboxRunning } from '../host/platform.js';
import { hostClaudeMemDir, syncClaudeMem, type MemResult } from './claude-mem.js';
import { readSyncState, syncHistoryIn, syncHistoryOut, writeSyncState, type SyncPaths, type SyncState } from './history.js';

const WATCH_INTERVAL_MS = 60 * 1000;

const storageOf = (dataPath: string): string => path.dirname(path.dirname(dataPath));
const guestClaude = (dataPath: string): string => path.join(dataPath, 'state', 'claude');
const guestMem = (dataPath: string): string => path.join(dataPath, 'state', 'claude-mem');

/** Sync paths for the sandbox side, after checking nothing on the way there is a link planted by the sandbox. */
const toPaths = (state: SyncState, dataPath: string): SyncPaths => {
  assertNoLinks(dataPath, guestClaude(dataPath));
  return { hostClaudeDir: state.hostClaudeDir, guestClaudeDir: guestClaude(dataPath), hostWorkspace: state.hostWorkspace, guestWorkspace: state.guestWorkspace, extra: state.projects ?? [] };
};

/**
 * A project registered while the sandbox runs: its history comes in now (the sandbox's copy only gains files), and
 * from now on syncs back to its own folder on this PC.
 */
export const syncProjectIn = (dataPath: string, project: { hostWorkspace: string; guestWorkspace: string }): number => {
  const state = readSyncState(dataPath);
  if (!state) return 0;
  const projects = [...(state.projects ?? []).filter((p) => p.hostWorkspace.toLowerCase() !== project.hostWorkspace.toLowerCase()), project];
  const next: SyncState = { ...state, projects };
  writeSyncState(dataPath, next);
  // Prompt history is left alone: sessions are appending to the sandbox's copy right now.
  return state.syncHistory ? syncHistoryIn(toPaths(next, dataPath), { promptHistory: false }) : 0;
};

const memSync = (dataPath: string, state: SyncState, direction: 'in' | 'out'): MemResult => {
  assertNoLinks(dataPath, guestMem(dataPath));
  return syncClaudeMem(hostClaudeMemDir(), guestMem(dataPath), state, direction);
};

export interface SyncSummary { history: number; claudeMem: MemResult | 'disabled' }

/** Before launch: finish syncing the previous run out, then bring this PC's history (and claude-mem) in. */
export const syncBeforeLaunch = (config: Config, dataPath: string, hostWorkspace: string): SyncSummary => {
  const profile = config.claudeProfile;
  const summary: SyncSummary = { history: 0, claudeMem: 'disabled' };
  if (!config.storage.persistAgentState) return summary;
  const previous = readSyncState(dataPath);
  if (previous?.syncHistory) syncHistoryOut(toPaths(previous, dataPath));
  const state: SyncState = { ...previous, hostClaudeDir: hostClaudeDir(profile), hostWorkspace, guestWorkspace: config.guestWorkspace, syncHistory: profile.syncHistory, syncClaudeMem: profile.syncClaudeMem, projects: [] };
  if (profile.syncHistory) summary.history = syncHistoryIn(toPaths(state, dataPath));
  if (profile.syncClaudeMem) {
    if (previous?.syncClaudeMem) memSync(dataPath, state, 'out');
    summary.claudeMem = memSync(dataPath, state, 'in');
  }
  writeSyncState(dataPath, state);
  return summary;
};

/** Syncs the sandbox's history (and, when `final`, claude-mem) back to this PC, as configured for the last launch. */
export const syncBack = (dataPath: string, final: boolean): SyncSummary => {
  const state = readSyncState(dataPath);
  const summary: SyncSummary = { history: 0, claudeMem: 'disabled' };
  if (!state) return summary;
  if (state.syncHistory) summary.history = syncHistoryOut(toPaths(state, dataPath));
  if (final && state.syncClaudeMem) summary.claudeMem = memSync(dataPath, state, 'out');
  writeSyncState(dataPath, state);
  return summary;
};

const hostRunDir = (dataPath: string): string => path.join(storageOf(dataPath), 'run');
const watcherPidFile = (dataPath: string): string => path.join(hostRunDir(dataPath), 'watcher-' + path.basename(dataPath) + '.pid');
const watcherLog = (dataPath: string): string => path.join(storageOf(dataPath), 'logs', 'host-sync-' + path.basename(dataPath) + '.log');
// Signal 0 only asks whether the process exists. pid 0 would mean "my own process group", so it never counts.
const alive = (pid: number): boolean => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

export const watcherRunning = (dataPath: string): boolean => {
  try { return alive(Number(fs.readFileSync(watcherPidFile(dataPath), 'utf8'))); } catch { return false; }
};

/** Body of the detached watcher process (`agent-sandbox _watch`). */
export const watch = async (dataPath: string): Promise<void> => {
  refuseInSelfTest('start the background sync');
  if (watcherRunning(dataPath)) return;
  fs.mkdirSync(hostRunDir(dataPath), { recursive: true });
  fs.mkdirSync(path.dirname(watcherLog(dataPath)), { recursive: true });
  writeFileAtomic(watcherPidFile(dataPath), String(process.pid));
  const note = (message: string): void => { try { fs.appendFileSync(watcherLog(dataPath), new Date().toISOString() + ' ' + message + '\n'); } catch { /* ignore */ } };
  const sync = (final: boolean): void => {
    try {
      for (const finding of checkRepo(dataPath)) note('SECURITY: neutralised a git ' + finding.kind + ' added inside the sandbox: ' + finding.detail);
    } catch (e) { note('repo guard failed: ' + errMsg(e)); }
    try {
      const s = syncBack(dataPath, final);
      if (s.history || final) note((final ? 'sandbox closed; final sync: ' : '') + 'history ' + s.history + ', claude-mem ' + s.claudeMem);
    } catch (e) { note('sync failed: ' + errMsg(e)); }
  };
  try {
    await sleep(30000);
    while (isSandboxRunning()) { sync(false); await sleep(WATCH_INTERVAL_MS); }
    await sleep(3000);
    sync(true);
  } finally {
    fs.rmSync(watcherPidFile(dataPath), { force: true });
  }
};
