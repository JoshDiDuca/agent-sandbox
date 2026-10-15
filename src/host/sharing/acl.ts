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

const ACL_TIMEOUT_MS = 30000;

/** One run of native\scripts\set-folder-access.ps1 over `entries` (the JSON's "changes"); throws a UserError. */
function runScript(entries: readonly object[]): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sandbox-acl-'));
  const file = path.join(dir, 'changes.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ changes: entries }, null, 2), 'utf8');
    const run = spawnSync(SYSTEM.powershell(), nativeScript('set-folder-access.ps1', ['-Json', file]), {
      encoding: 'utf8',
      windowsHide: true,
      timeout: ACL_TIMEOUT_MS,
    });
    const timedOut = (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    if (timedOut)
      fail(
        'Changing the folder permissions took longer than ' + ACL_TIMEOUT_MS / 1000 + ' seconds and was stopped.',
        'Close programs that scan or lock the folders (virus scanners, file explorers) and try again.',
      );
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

/**
 * Applies the changes with native\scripts\set-folder-access.ps1 (refusing links; writing nothing when an entry would
 * change nothing, and a folder's own entry without touching what is inside it). Throws with the script's reason when a
 * change fails or takes over 30 seconds. The self-test guard is in applyAcl; the self-test calls this only on its temp
 * folders.
 */
export function runFolderAccess(changes: readonly AclChange[]): void {
  if (changes.length === 0) return;
  runScript(changes);
}

/** Applies sharing changes on this PC (refused inside the self-test). */
export function applyAcl(changes: readonly AclChange[]): void {
  refuseInSelfTest('change folder permissions');
  runFolderAccess(changes);
}

/** Makes an existing folder private (see protectPrivateFolder) without the self-test guard: for temp folders only. */
export function runPrivateFolder(dir: string): void {
  runScript([{ op: 'private', path: dir }]);
}

/**
 * Makes an existing folder (not a link) private: inheritance off, full control for you, SYSTEM and Administrators
 * only, inherited by what is created in it. Nothing is written when it already is; an empty folder is changed without
 * walking inside it.
 */
export function protectPrivateFolder(dir: string): void {
  refuseInSelfTest('change folder permissions');
  runPrivateFolder(dir);
}
