// Keeps storage from growing forever. Runs automatically on every launch and via `sandbox clean`.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { sizeOf } from '../core/disk.js';
import { dirExists, isLink } from '../core/util.js';
import { safeRemove } from '../shared/safe-remove.js';

const DAY = 24 * 60 * 60 * 1000;

export interface PruneOptions { launchDays: number; logDays: number; conflictDays: number; keep: string[]; now?: number }
export interface PruneResult { launches: number; logs: number; leftovers: number; bytes: number }

export const DEFAULT_PRUNE: PruneOptions = { launchDays: 7, logDays: 14, conflictDays: 30, keep: [] };

const ageMs = (p: string, now: number): number => { try { return now - fs.lstatSync(p).mtimeMs; } catch { return 0; } };

/** Entries of a real folder; a link in place of a folder yields nothing (it is never listed or entered). */
const children = (dir: string): string[] => (dirExists(dir) && !isLink(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name)) : []);

/**
 * Deletes, under the storage root:
 *  - launch folders older than `launchDays` (a launch folder is only used by the sandbox it started; `keep` protects the running one)
 *  - sandbox logs older than `logDays`
 *  - interrupted downloads/copies (*.staging-*, *.incoming, *.tmp) older than a day
 *  - claude-mem conflict copies older than `conflictDays`
 */
export const pruneStorage = (storageRoot: string, options: Partial<PruneOptions> = {}): PruneResult => {
  const o = { ...DEFAULT_PRUNE, ...options };
  const now = o.now ?? Date.now();
  const result: PruneResult = { launches: 0, logs: 0, leftovers: 0, bytes: 0 };
  const remove = (p: string, counter: keyof Omit<PruneResult, 'bytes'>): void => {
    result.bytes += sizeOf(p);
    safeRemove(p, storageRoot);
    result[counter]++;
  };

  for (const launch of children(path.join(storageRoot, 'launches'))) {
    if (!o.keep.includes(path.basename(launch)) && ageMs(launch, now) > o.launchDays * DAY) remove(launch, 'launches');
  }
  for (const data of children(path.join(storageRoot, 'data'))) {
    for (const log of children(path.join(data, 'logs'))) if (ageMs(log, now) > o.logDays * DAY) remove(log, 'logs');
    const runDir = path.join(data, 'run');
    const dirs = [path.join(data, 'tools'), path.join(data, 'state'), ...(isLink(runDir) ? [] : [runDir, path.join(runDir, 'responses')])];
    for (const dir of dirs) {
      for (const entry of children(dir)) {
        const name = path.basename(entry);
        const leftover = /\.staging-[0-9a-f]+$|\.incoming$|\.tmp$/i.test(name) && ageMs(entry, now) > DAY;
        const oldResponse = dir.endsWith('responses') && ageMs(entry, now) > DAY;
        const oldConflict = /\.conflict-\d+$/.test(name) && ageMs(entry, now) > o.conflictDays * DAY;
        if (leftover || oldResponse || oldConflict) remove(entry, 'leftovers');
      }
    }
  }
  return result;
};

export const describePrune = (r: PruneResult): string =>
  r.launches + r.logs + r.leftovers === 0 ? 'nothing to clean' : _.compact([r.launches && r.launches + ' launch folder(s)', r.logs && r.logs + ' log(s)', r.leftovers && r.leftovers + ' leftover(s)']).join(', ') + ' removed (' + Math.round(r.bytes / 1048576) + ' MB)';
