// Reading a folder's permissions from `icacls <folder>` (read only): who has an entry, and is it inherited. Used to
// tell whether a user's data folder is private and whether the sharing group still has entries on folders it should
// not.
import path from 'node:path';

/** The Windows group of the users who may use a shared sandbox. */
export const SHARING_GROUP = 'Agent Sandbox Users';

export interface AclEntry {
  readonly principal: string;
  /** The flags in order, e.g. "(OI)(CI)(F)". */
  readonly flags: string;
  readonly inherited: boolean;
  readonly deny: boolean;
}

/** Entries of `icacls` output for `dir` (the first line starts with the folder's path). */
export function parseIcacls(text: string, dir: string): AclEntry[] {
  const entries: AclEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*(Successfully processed|Failed processing)/i.test(line)) break;
    if (i === 0 && line.toLowerCase().startsWith(dir.toLowerCase())) line = line.slice(dir.length);
    const m = /^\s*(\S.*?):((?:\([A-Za-z0-9,]+\))+)\s*$/.exec(line);
    if (!m) continue;
    entries.push({
      principal: m[1].trim(),
      flags: m[2],
      inherited: m[2].includes('(I)'),
      deny: m[2].includes('(DENY)'),
    });
  }
  return entries;
}

const BROAD = /(^|\\)(Everyone|Users|Authenticated Users)$/i;

/** The entries that make a folder readable by more than you, SYSTEM and Administrators (empty: it is private). */
export function privacyProblems(entries: readonly AclEntry[], groupName: string): string[] {
  const group = new RegExp('(^|\\\\)' + groupName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  return entries
    .filter((e) => !e.deny && (BROAD.test(e.principal) || group.test(e.principal) || e.inherited))
    .map((e) => e.principal + (e.inherited ? ' (inherited)' : ''));
}

/** Entries of the sharing group (the folders it may enter only while a shared sandbox runs). */
export function groupEntries(entries: readonly AclEntry[], groupName: string): AclEntry[] {
  const group = new RegExp('(^|\\\\)' + groupName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  return entries.filter((e) => group.test(e.principal));
}

/** The folders a sharing plan touches for one user's data set: the storage folder, data folder, data set and run. */
export function sharedFolders(storageUserDir: string, dataPath: string): string[] {
  return [storageUserDir, path.dirname(dataPath), dataPath, path.join(dataPath, 'run')];
}
