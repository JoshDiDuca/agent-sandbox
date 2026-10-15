// Does the sharing group still have an entry on one of the folders a sharing plan touches? Read-only (icacls), so a
// launch that shares nothing can skip the permission script when the answer is no.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
// acl-read.ts is pure; the health barrel would make a cycle (health reads the process list from sharing).
import { SHARING_GROUP, groupEntries, parseIcacls } from '../health/acl-read.js';

/**
 * true when the group has an entry on any of the existing folders, or when that cannot be read (fail closed: the
 * caller then removes the entries and refuses the launch if that fails). false only when every folder was read and
 * none has a group entry.
 */
export function groupHasAccess(dirs: readonly string[]): boolean {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const run = spawnSync(SYSTEM.icacls(), [dir], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (run.status !== 0 || run.error) return true;
    if (groupEntries(parseIcacls(run.stdout ?? '', dir), SHARING_GROUP).length > 0) return true;
  }
  return false;
}
