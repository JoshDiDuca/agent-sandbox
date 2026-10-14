// The folder permissions that let other users of an all-users install use a sandbox this user started, and the ones
// that take them away again. Only these entries change: nothing else in the user's storage is opened.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fail } from '../../core/util/index.js';
import { SYSTEM } from '../../shared/system.js';
import { nativeScript } from '../native.js';
import { refuseInSelfTest } from '../test-guard.js';

export interface AclChange {
  path: string;
  /** The group's SID (the other users of this PC). */
  sid: string;
  rights: 'Read' | 'Traverse' | 'Modify';
  /** this-folder: the entry applies to that folder only. inherit: files and folders below inherit it. */
  scope: 'this-folder' | 'inherit';
  /** true = grant, false = remove the same entry. */
  add: boolean;
}

/**
 * The entries for sharing (on) or unsharing (off) a user's sandbox data. `storageUserDir` is the user's storage folder,
 * `dataPath` the data set (storage\data\<name>, so its parent is the data folder). Other users may enter the three
 * folders (Traverse, this folder only) and modify what is in the set's run folder (inherited), which is where the
 * sessions and requests are.
 */
export function sharingAclPlan(o: {
  storageUserDir: string;
  dataPath: string;
  groupSid: string;
  on: boolean;
}): AclChange[] {
  const dataFolder = path.dirname(o.dataPath);
  if (path.dirname(dataFolder) !== o.storageUserDir)
    throw new Error('The data set ' + o.dataPath + ' is not under ' + o.storageUserDir + '\\data.');
  const entry = (p: string, rights: AclChange['rights'], scope: AclChange['scope']): AclChange => ({
    path: p,
    sid: o.groupSid,
    rights,
    scope,
    add: o.on,
  });
  return [
    entry(o.storageUserDir, 'Traverse', 'this-folder'),
    entry(dataFolder, 'Traverse', 'this-folder'),
    entry(o.dataPath, 'Traverse', 'this-folder'),
    entry(path.join(o.dataPath, 'run'), 'Modify', 'inherit'),
  ];
}

/**
 * Applies the changes with native\scripts\set-folder-access.ps1 (Get-Acl / Set-Acl, refusing links). Throws with the
 * script's reason when a change fails. The self-test guard is in applyAcl; the self-test calls this only on its temp
 * folders.
 */
export function runFolderAccess(changes: readonly AclChange[]): void {
  if (changes.length === 0) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sandbox-acl-'));
  const file = path.join(dir, 'changes.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ changes }, null, 2), 'utf8');
    const run = spawnSync(SYSTEM.powershell(), nativeScript('set-folder-access.ps1', ['-Json', file]), {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    });
    if (run.status !== 0 || run.error) {
      const reason = (run.stderr || run.stdout || run.error?.message || 'no output').trim();
      fail(
        'Could not change the folder permissions: ' + reason,
        'Check that the folders are not links and that you can change their permissions, then try again.',
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Applies sharing changes on this PC (refused inside the self-test). */
export function applyAcl(changes: readonly AclChange[]): void {
  refuseInSelfTest('change folder permissions');
  runFolderAccess(changes);
}
