// When history and claude-mem move: in before every launch, out every minute while the sandbox runs (history) and
// once more when it closes (history + claude-mem). The watcher runs detached on the host for the sandbox's lifetime.
// Its pid file and log live in host-only storage, never in the data folder the sandbox can write.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../core/types.js';
import { writeFileAtomic } from '../shared/io/index.js';
import { refuseInSelfTest } from '../host/test-guard.js';
import { assertNoLinks, errMsg, sleep } from '../core/util/index.js';
import { hostClaudeDir } from '../host/claude-profile.js';
import { checkRepo } from '../host/repo-guard.js';
import { isSandboxRunning } from '../host/platform.js';
import { readActiveViews, WorkspaceView } from '../host/workspace-view/index.js';
import { readForwards, sandboxAddress, startPortForwards } from '../host/port-forward.js';
import { AuditCollector, readAuditSettings } from '../host/audit/collect.js';
import { readMarkedProjects, saveDataSize, watchAndMark } from '../host/motw.js';
import { sizeOf } from '../core/disk.js';
import { beatLife, causeSince, endLife, keepAwake, readLife } from '../host/stops.js';
import { hostClaudeMemDir, syncClaudeMem, type MemResult } from './claude-mem.js';
import {
  readSyncState,
  syncHistoryIn,
  syncHistoryOut,
  writeSyncState,
  type SyncPaths,
  type SyncState,
} from './history.js';

const WATCH_INTERVAL_MS = 60 * 1000;

const storageOf = (dataPath: string): string => path.dirname(path.dirname(dataPath));
const guestClaude = (dataPath: string): string => path.join(dataPath, 'state', 'claude');
const guestMem = (dataPath: string): string => path.join(dataPath, 'state', 'claude-mem');

/** Sync paths for the sandbox side, after checking nothing on the way there is a link planted by the sandbox. */
const toPaths = (state: SyncState, dataPath: string): SyncPaths => {
  assertNoLinks(dataPath, guestClaude(dataPath));
  return {
    hostClaudeDir: state.hostClaudeDir,
    guestClaudeDir: guestClaude(dataPath),
    hostWorkspace: state.hostWorkspace,
    guestWorkspace: state.guestWorkspace,
    extra: state.projects ?? [],
  };
};

/**
 * A project registered while the sandbox runs: its history comes in now (the sandbox's copy only gains files), and
 * from now on syncs back to its own folder on this PC.
 */
export const syncProjectIn = (dataPath: string, project: { hostWorkspace: string; guestWorkspace: string }): number => {
  const state = readSyncState(dataPath);
  if (!state) return 0;
  const projects = [
    ...(state.projects ?? []).filter((p) => p.hostWorkspace.toLowerCase() !== project.hostWorkspace.toLowerCase()),
    project,
  ];
  const next: SyncState = { ...state, projects };
  writeSyncState(dataPath, next);
  // Prompt history is left alone: sessions are appending to the sandbox's copy right now.
  return state.syncHistory
    ? syncHistoryIn(toPaths(next, dataPath), { promptHistory: false, scope: state.historyScope })
    : 0;
};

const memSync = (dataPath: string, state: SyncState, direction: 'in' | 'out'): MemResult => {
  assertNoLinks(dataPath, guestMem(dataPath));
  return syncClaudeMem(hostClaudeMemDir(), guestMem(dataPath), state, direction);
};

export interface SyncSummary {
  history: number;
  claudeMem: MemResult | 'disabled';
}

/** Before launch: finish syncing the previous run out, then bring this PC's history (and claude-mem) in. */
export const syncBeforeLaunch = (config: Config, dataPath: string, hostWorkspace: string): SyncSummary => {
  const profile = config.claudeProfile;
  const summary: SyncSummary = { history: 0, claudeMem: 'disabled' };
  if (!config.storage.persistAgentState) return summary;
  const previous = readSyncState(dataPath);
  if (previous?.syncHistory) syncHistoryOut(toPaths(previous, dataPath));
  const state: SyncState = {
    ...previous,
    hostClaudeDir: hostClaudeDir(profile),
    hostWorkspace,
    guestWorkspace: config.guestWorkspace,
    syncHistory: profile.syncHistory,
    historyScope: profile.historyScope,
    syncClaudeMem: profile.syncClaudeMem,
    syncClaudeMemBack: profile.syncClaudeMemBack,
    projects: [],
  };
  if (profile.syncHistory) summary.history = syncHistoryIn(toPaths(state, dataPath), { scope: profile.historyScope });
  if (profile.syncClaudeMem) {
    if (previous?.syncClaudeMem && previous.syncClaudeMemBack) memSync(dataPath, state, 'out');
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
  if (final && state.syncClaudeMem && state.syncClaudeMemBack) summary.claudeMem = memSync(dataPath, state, 'out');
  writeSyncState(dataPath, state);
  return summary;
};

const hostRunDir = (dataPath: string): string => path.join(storageOf(dataPath), 'run');
const watcherPidFile = (dataPath: string): string =>
  path.join(hostRunDir(dataPath), 'watcher-' + path.basename(dataPath) + '.pid');
const watcherLog = (dataPath: string): string =>
  path.join(storageOf(dataPath), 'logs', 'host-sync-' + path.basename(dataPath) + '.log');
// Signal 0 only asks whether the process exists. pid 0 would mean "my own process group", so it never counts.
const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const watcherRunning = (dataPath: string): boolean => {
  try {
    return alive(Number(fs.readFileSync(watcherPidFile(dataPath), 'utf8')));
  } catch {
    return false;
  }
};

/** Body of the detached watcher process (`agent-sandbox _watch`). */
export const watch = async (dataPath: string): Promise<void> => {
  refuseInSelfTest('start the background sync');
  if (watcherRunning(dataPath)) return;
  fs.mkdirSync(hostRunDir(dataPath), { recursive: true });
  fs.mkdirSync(path.dirname(watcherLog(dataPath)), { recursive: true });
  writeFileAtomic(watcherPidFile(dataPath), String(process.pid));
  const note = (message: string): void => {
    try {
      fs.appendFileSync(watcherLog(dataPath), new Date().toISOString() + ' ' + message + '\n');
    } catch {
      /* ignore */
    }
  };
  const sync = (final: boolean): void => {
    try {
      for (const finding of checkRepo(dataPath)) {
        note('SECURITY: neutralised a git ' + finding.kind + ' added inside the sandbox: ' + finding.detail);
        audit?.guard(finding.kind + ': ' + finding.detail);
      }
    } catch (e) {
      note('repo guard failed: ' + errMsg(e));
    }
    try {
      const s = syncBack(dataPath, final);
      if (s.history || final)
        note((final ? 'sandbox closed; final sync: ' : '') + 'history ' + s.history + ', claude-mem ' + s.claudeMem);
    } catch (e) {
      note('sync failed: ' + errMsg(e));
    }
  };
  // workspaceFilter: each filtered project is kept in step with its view from now until the sandbox closes.
  // audit.enabled: programs, files, sessions and guard findings into the host-only audit log.
  const auditSettings = readAuditSettings(storageOf(dataPath), dataPath);
  const audit = auditSettings?.enabled ? new AuditCollector(dataPath, storageOf(dataPath), auditSettings) : null;
  audit?.start();
  const auditTimer = audit
    ? setInterval(() => {
        try {
          audit.flush();
        } catch (e) {
          note('audit: ' + errMsg(e));
        }
      }, 10000)
    : null;
  // storage.markSandboxFiles: programs and scripts that appear in the projects get the "from the internet" mark.
  const stopMarking = watchAndMark(readMarkedProjects(storageOf(dataPath), dataPath), (m) => note(m));
  // network.forwardPorts: localhost on this PC reaches servers in the sandbox while it runs.
  const stopForwards = startPortForwards(
    readForwards(storageOf(dataPath), dataPath),
    () => sandboxAddress(dataPath),
    (m) => note('port forward: ' + m),
  );
  const views = readActiveViews(storageOf(dataPath), dataPath);
  const stops = views.flatMap((v) => {
    try {
      return [new WorkspaceView({ ...v, note: (m) => note('workspace ' + v.host + ': ' + m) }).watch()];
    } catch (e) {
      note('workspace ' + v.host + ': could not watch: ' + errMsg(e));
      return [];
    }
  });
  // sandbox.keepAwake, and the life record that tells the next launch how this run ended (host/stops.ts).
  const awake = readLife(storageOf(dataPath), dataPath)?.keepAwake ? keepAwake(process.pid) : null;
  try {
    await sleep(30000);
    while (isSandboxRunning()) {
      beatLife(storageOf(dataPath), dataPath);
      sync(false);
      await sleep(WATCH_INTERVAL_MS);
    }
    try {
      const life = readLife(storageOf(dataPath), dataPath);
      const cause = life ? causeSince(life.lastSeen) : null;
      endLife(storageOf(dataPath), dataPath, cause);
      if (cause) note('sandbox ended: ' + cause.text);
    } catch (e) {
      note('could not record how the sandbox ended: ' + errMsg(e));
    }
    await sleep(3000);
    sync(true);
  } finally {
    awake?.kill();
    stops.forEach((stop) => stop());
    stopForwards();
    stopMarking();
    if (auditTimer) clearInterval(auditTimer);
    try {
      audit?.stop();
    } catch (e) {
      note('audit: ' + errMsg(e));
    }
    for (const v of views) {
      try {
        const s = new WorkspaceView(v).syncAll();
        note('workspace ' + v.host + ': final sync ' + s.toHost + ' out, ' + s.toView + ' in');
      } catch (e) {
        note('workspace ' + v.host + ': final sync failed: ' + errMsg(e));
      }
    }
    // For the next launch's storage.warnDataGb (measuring then would be slow).
    try {
      saveDataSize(storageOf(dataPath), dataPath, sizeOf(dataPath));
    } catch {
      /* best effort */
    }
    fs.rmSync(watcherPidFile(dataPath), { force: true });
  }
};
