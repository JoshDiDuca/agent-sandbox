// When history and claude-mem move: in before every launch, out every minute while the sandbox runs (history) and
// once more when it closes (history + claude-mem). The watcher runs detached on the host for the sandbox's lifetime.
// Its pid file and log live in host-only storage, never in the data folder the sandbox can write.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../shared/io/index.js';
import { refuseInSelfTest } from '../host/test-guard.js';
import { errMsg, sleep } from '../core/util/index.js';
import { RepoGuardStore } from '../host/guard/index.js';
import { isSandboxRunning } from '../host/sandbox/index.js';
import { readActiveViews } from '../host/workspace-view/index.js';
import { WorkspaceView } from '../host/workspace-view/index.js';
import { readForwards, sandboxAddress, startPortForwards } from '../host/network/index.js';
import { AuditCollector, readAuditSettings } from '../host/audit/collect.js';
import { readMarkedProjects, saveDataSize, watchAndMark } from '../host/guard/index.js';
import { sizeWithin } from '../core/disk.js';
import { causeSince, KeepAwake, LifeRecord } from '../host/life/index.js';
import { storageOf } from '../host/storage/index.js';
import { syncBack } from './sync-cycle.js';

const WATCH_INTERVAL_MS = 60 * 1000;

const hostRunDir = (dataPath: string): string => path.join(storageOf(dataPath), 'run');
/** The longest the watcher may take after the sandbox closed (final syncs) before it stops anyway. */
const END_DEADLINE_MS = 3 * 60 * 1000;

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
      for (const finding of new RepoGuardStore(dataPath).check()) {
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
  const life = new LifeRecord(storageOf(dataPath), dataPath);
  const awake = life.read()?.keepAwake ? KeepAwake.start(process.pid) : null;
  try {
    await sleep(30000);
    while (isSandboxRunning()) {
      life.beat();
      sync(false);
      await sleep(WATCH_INTERVAL_MS);
    }
    try {
      const last = life.read();
      const cause = last ? causeSince(last.lastSeen) : null;
      life.end(cause);
      if (cause) note('sandbox ended: ' + cause.text);
    } catch (e) {
      note('could not record how the sandbox ended: ' + errMsg(e));
    }
    await sleep(3000);
    // The sandbox is gone: this process ends within minutes whatever happens below (it must never outlive the sandbox).
    setTimeout(() => {
      note('final work took too long; stopped.');
      fs.rmSync(watcherPidFile(dataPath), { force: true });
      process.exit(0);
    }, END_DEADLINE_MS).unref();
    sync(true);
  } finally {
    awake?.stop();
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
    // For the next launch's storage.warnDataGb, only when it can be measured quickly (a big data folder takes minutes).
    try {
      const bytes = sizeWithin(dataPath, 20000);
      if (bytes !== null) saveDataSize(storageOf(dataPath), dataPath, bytes);
    } catch {
      /* best effort */
    }
    fs.rmSync(watcherPidFile(dataPath), { force: true });
  }
};
