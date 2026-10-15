// What a closed or crashed sandbox leaves behind, and how to tell it from what is in use: records of sandboxes that are
// gone, run files, old launch folders, background watchers with nothing to watch. These only look; the repair checks
// remove through the safe helpers. Everything takes its folders as arguments, so tests use temp folders.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { dirExists, isLink } from '../../core/util/index.js';
import { RunDir } from '../../shared/channel/index.js';
import type { ActiveSandbox, TaskRow } from '../sharing/index.js';

const DAY = 24 * 60 * 60 * 1000;
const SANDBOX_IMAGES = ['windowssandboxclient.exe', 'windowssandboxremotesession.exe', 'windowssandbox.exe'];
/** A watcher this old, with its log quiet and no sandbox, is left over (a finishing one is done within minutes). */
export const WATCHER_MIN_AGE_MS = 10 * 60 * 1000;
export const WATCHER_LOG_QUIET_MS = 5 * 60 * 1000;

/** Windows sessions that have a sandbox running (empty: none runs). */
export function sandboxSessions(rows: readonly TaskRow[]): number[] {
  const found = rows.filter((r) => SANDBOX_IMAGES.includes(r.image.toLowerCase()));
  return [...new Set(found.map((r) => r.session))];
}

/** Sharing records whose Windows session has no sandbox running (nothing else removes them after a crash). */
export function staleActiveRecords(records: readonly ActiveSandbox[], rows: readonly TaskRow[]): ActiveSandbox[] {
  const sessions = sandboxSessions(rows);
  return records.filter((r) => !sessions.includes(r.windowsSession));
}

export interface RunStateProblems {
  /** Sessions still marked running or starting. */
  readonly sessions: number;
  /** Requests nobody answered (valid or not). */
  readonly requests: number;
  /** The sandbox status file says the boot never finished (booting, provisioning, failed). */
  readonly unfinishedBoot: string | null;
  readonly any: boolean;
}

/** What is left in <data>\run by a sandbox that is no longer running. */
export function runStateProblems(dataPath: string): RunStateProblems {
  const run = new RunDir(dataPath);
  const sessions = run.listSessions().filter((s) => s.phase === 'running' || s.phase === 'starting').length;
  const found = run.scanRequests();
  const requests = found.valid.length + found.invalid.length;
  const phase = run.readSandboxStatus()?.phase;
  const unfinishedBoot = phase && phase !== 'ready' ? phase : null;
  return { sessions, requests, unfinishedBoot, any: sessions > 0 || requests > 0 || unfinishedBoot !== null };
}

export interface OldLaunch {
  readonly path: string;
  readonly ageDays: number;
}

/** Launch folders under <storage>\launches that nothing has touched for `days` days (each is a finished start). */
export function staleLaunchFolders(
  storageRoot: string,
  days: number,
  now: number,
  keep: readonly string[] = [],
): OldLaunch[] {
  const dir = path.join(storageRoot, 'launches');
  if (!dirExists(dir) || isLink(dir)) return [];
  const found: OldLaunch[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (keep.includes(name)) continue;
    const full = path.join(dir, name);
    try {
      const age = now - fs.lstatSync(full).mtimeMs;
      if (age > days * DAY) found.push({ path: full, ageDays: Math.floor(age / DAY) });
    } catch {
      // gone while we looked
    }
  }
  return found;
}

export interface WatcherInfo {
  readonly file: string;
  readonly pid: number | null;
  readonly ageMs: number;
  /** How long ago the watcher's log was written; null when there is none. */
  readonly logAgeMs: number | null;
}

const PidSchema = z.coerce.number().int().positive();

/** The history-sync watcher records in <storage>\run (watcher-<data set>.pid) with the age of each and of its log. */
export function watcherRecords(storageRoot: string, now: number): WatcherInfo[] {
  const dir = path.join(storageRoot, 'run');
  if (!dirExists(dir) || isLink(dir)) return [];
  const age = (p: string): number | null => {
    try {
      return now - fs.statSync(p).mtimeMs;
    } catch {
      return null;
    }
  };
  return fs
    .readdirSync(dir)
    .map((name) => ({ name, m: /^watcher-(.+)\.pid$/i.exec(name) }))
    .flatMap(({ name, m }) => {
      if (!m) return [];
      const file = path.join(dir, name);
      let pid: number | null = null;
      try {
        const parsed = PidSchema.safeParse(fs.readFileSync(file, 'utf8').trim());
        pid = parsed.success ? parsed.data : null;
      } catch {
        return [];
      }
      return [
        {
          file,
          pid,
          ageMs: age(file) ?? 0,
          logAgeMs: age(path.join(storageRoot, 'logs', 'host-sync-' + m[1] + '.log')),
        },
      ];
    });
}

/**
 * Watchers that run with no sandbox to watch: the process is alive and is a Node program (a recycled pid is somebody
 * else's), no sandbox runs, and neither its record nor its log has changed for a while (a finishing watcher is spared).
 */
export function orphanWatchers(
  infos: readonly WatcherInfo[],
  o: { running: boolean; alive: (pid: number) => boolean; image: (pid: number) => string | null },
): WatcherInfo[] {
  if (o.running) return [];
  return infos.filter(
    (w) =>
      w.pid !== null &&
      o.alive(w.pid) &&
      o.image(w.pid)?.toLowerCase() === 'node.exe' &&
      w.ageMs > WATCHER_MIN_AGE_MS &&
      (w.logAgeMs === null || w.logAgeMs > WATCHER_LOG_QUIET_MS),
  );
}

/** null when a small file can be created in the folder, else the reason (the file is removed again). */
export function writeProblem(dir: string): string | null {
  const probe = path.join(dir, '.write-test-' + process.pid);
  try {
    fs.writeFileSync(probe, '');
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? String(e);
  } finally {
    fs.rmSync(probe, { force: true });
  }
}
