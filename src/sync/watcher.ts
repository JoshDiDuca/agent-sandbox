// When history and claude-mem move: in before every launch, out every minute while the sandbox runs (history) and
// once more when it closes (history + claude-mem). The watcher runs detached on the host for the sandbox's lifetime.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../core/types.js';
import { hostClaudeMemDir, readSyncState, syncClaudeMem, syncHistoryIn, syncHistoryOut, writeSyncState, type MemResult, type SyncPaths, type SyncState } from './history.js';
import { hostClaudeDir } from '../host/claude-profile.js';
import { isSandboxRunning } from '../host/platform.js';
import { errMsg, sleep } from '../core/util.js';

const WATCH_INTERVAL_MS = 60 * 1000;

const guestClaude = (dataPath: string): string => path.join(dataPath, 'state', 'claude');
const guestMem = (dataPath: string): string => path.join(dataPath, 'state', 'claude-mem');
const toPaths = (state: SyncState, dataPath: string): SyncPaths => ({ hostClaudeDir: state.hostClaudeDir, guestClaudeDir: guestClaude(dataPath), hostWorkspace: state.hostWorkspace, guestWorkspace: state.guestWorkspace });

export interface SyncSummary { history: number; claudeMem: MemResult | 'disabled' }

/** Before launch: finish syncing the previous run out, then bring this PC's history (and claude-mem) in. */
export const syncBeforeLaunch = (config: Config, dataPath: string, hostWorkspace: string): SyncSummary => {
  const profile = config.claudeProfile;
  const summary: SyncSummary = { history: 0, claudeMem: 'disabled' };
  if (!config.storage.persistAgentState) return summary;
  const previous = readSyncState(dataPath);
  if (previous && profile.syncHistory) syncHistoryOut(toPaths(previous, dataPath));
  const state: SyncState = { ...previous, hostClaudeDir: hostClaudeDir(profile), hostWorkspace, guestWorkspace: config.guestWorkspace };
  if (profile.syncHistory) summary.history = syncHistoryIn(toPaths(state, dataPath));
  if (profile.syncClaudeMem) {
    if (previous) syncClaudeMem(hostClaudeMemDir(), guestMem(dataPath), state, 'out');
    summary.claudeMem = syncClaudeMem(hostClaudeMemDir(), guestMem(dataPath), state, 'in');
  }
  writeSyncState(dataPath, state);
  return summary;
};

/** Syncs the sandbox's history (and, when `final`, claude-mem) back to this PC. */
export const syncBack = (config: Config, dataPath: string, final: boolean): SyncSummary => {
  const state = readSyncState(dataPath);
  const summary: SyncSummary = { history: 0, claudeMem: 'disabled' };
  if (!state) return summary;
  if (config.claudeProfile.syncHistory) summary.history = syncHistoryOut(toPaths(state, dataPath));
  if (final && config.claudeProfile.syncClaudeMem) summary.claudeMem = syncClaudeMem(hostClaudeMemDir(), guestMem(dataPath), state, 'out');
  writeSyncState(dataPath, state);
  return summary;
};

const watcherPidFile = (dataPath: string): string => path.join(dataPath, 'run', 'watcher.pid');
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

export const watcherRunning = (dataPath: string): boolean => {
  try { return alive(Number(fs.readFileSync(watcherPidFile(dataPath), 'utf8'))); } catch { return false; }
};

/** Body of the detached watcher process (`agent-sandbox _watch`). */
export const watch = async (config: Config, dataPath: string): Promise<void> => {
  if (watcherRunning(dataPath)) return;
  fs.mkdirSync(path.dirname(watcherPidFile(dataPath)), { recursive: true });
  fs.writeFileSync(watcherPidFile(dataPath), String(process.pid));
  const logFile = path.join(dataPath, 'logs', 'host-sync.log');
  const note = (message: string): void => { try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + message + '\n'); } catch { /* ignore */ } };
  try {
    await sleep(30000);
    while (isSandboxRunning()) {
      try { const s = syncBack(config, dataPath, false); if (s.history) note('history: ' + s.history + ' item(s) synced back'); } catch (e) { note('sync failed: ' + errMsg(e)); }
      await sleep(WATCH_INTERVAL_MS);
    }
    await sleep(3000);
    const s = syncBack(config, dataPath, true);
    note('sandbox closed; final sync: history ' + s.history + ', claude-mem ' + s.claudeMem);
  } finally {
    fs.rmSync(watcherPidFile(dataPath), { force: true });
  }
};
