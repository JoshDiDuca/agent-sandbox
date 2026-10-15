// What the path picker needs from the disk and from text, as plain functions (tested): splitting what was typed,
// listing a folder without ever following links, completing a name, filtering, and the drives of "This PC".
import fs from 'node:fs';
import path from 'node:path';
import { diskUsage } from '../../../core/disk.js';

const win = path.win32;

export type EntryKind = 'drive' | 'up' | 'dir' | 'file' | 'link';

export interface PickEntry {
  readonly kind: EntryKind;
  readonly name: string;
  /** The full path it opens or picks ('' for the "This PC" level above a drive). */
  readonly path: string;
  /** Extra words: free space of a drive, "link". */
  readonly detail?: string;
}

export interface Listing {
  readonly entries: readonly PickEntry[];
  /** Entries left out because of the cap. */
  readonly more: number;
  /** Why the folder could not be read. */
  readonly error?: string;
}

/** Entries listed at most; the rest is counted ("... more"). */
export const LIST_CAP = 2000;

const SEPARATOR = /[\\/]$/;

/** What was typed, split into the folder it names (or is in) and the start of a name in it. '' = This PC. */
export function splitInput(input: string): { dir: string; prefix: string } {
  const text = input.trim();
  if (text === '') return { dir: '', prefix: '' };
  if (/^[A-Za-z]:$/.test(text)) return { dir: text + '\\', prefix: '' };
  if (SEPARATOR.test(text)) return { dir: text, prefix: '' };
  const dir = win.dirname(text);
  const base = win.basename(text);
  // A bare name (no folder) has no folder to look in.
  return dir === '.' ? { dir: '', prefix: base } : { dir, prefix: base };
}

/** The folder above, or '' (This PC) above a drive's root. */
export function parentOf(dir: string): string {
  if (dir === '') return '';
  const parent = win.dirname(win.resolve(dir));
  return parent.toLowerCase() === win.resolve(dir).toLowerCase() ? '' : parent;
}

/** `dir` with exactly one trailing backslash (for the input line). */
export function withSeparator(dir: string): string {
  return dir === '' ? '' : dir.replace(/[\\/]+$/, '') + '\\';
}

/** Folders first, then files, each by name without regard to case. */
function byKindThenName(a: PickEntry, b: PickEntry): number {
  const rank = (e: PickEntry): number => (e.kind === 'file' ? 1 : 0);
  return rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * The folders (and files when asked) in `dir`. Links and junctions are listed, marked, never opened; unreadable
 * folders give an error text; at most `cap` entries come back.
 */
export function listFolder(dir: string, files = false, cap = LIST_CAP): Listing {
  let found: fs.Dirent[];
  try {
    found = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      entries: [],
      more: 0,
      error: code === 'ENOENT' || code === 'ENOTDIR' ? 'No such folder' : 'Cannot open it',
    };
  }
  const entries: PickEntry[] = [];
  for (const d of found) {
    const full = win.join(dir, d.name);
    if (d.isSymbolicLink()) entries.push({ kind: 'link', name: d.name, path: full, detail: 'link' });
    else if (d.isDirectory()) entries.push({ kind: 'dir', name: d.name, path: full });
    else if (files) entries.push({ kind: 'file', name: d.name, path: full });
  }
  entries.sort(byKindThenName);
  return { entries: entries.slice(0, cap), more: Math.max(0, entries.length - cap) };
}

/** The drives of this PC with their free space ("This PC"). */
export function listDrives(): PickEntry[] {
  return diskUsage('C:\\').map((d) => ({
    kind: 'drive' as const,
    name: d.drive,
    path: d.drive,
    detail: freeText(d.freeBytes, d.totalBytes),
  }));
}

function freeText(free: number, total: number): string {
  const gb = (n: number): string =>
    (n / 1024 ** 3 >= 10 ? Math.round(n / 1024 ** 3) : (n / 1024 ** 3).toFixed(1)) + ' GB';
  return gb(free) + ' free of ' + gb(total);
}

/** Entries whose name starts with `prefix` (no case), or contains `text` when filtering. */
export function narrow(entries: readonly PickEntry[], prefix: string, text = ''): PickEntry[] {
  const start = prefix.toLowerCase();
  const inside = text.toLowerCase();
  return entries.filter((e) => {
    const name = e.name.toLowerCase();
    return name.startsWith(start) && name.includes(inside);
  });
}

/**
 * Completes the last name of `input` from the folders listed: the longest start they share, and a backslash when
 * exactly one folder fits. The input is returned unchanged when nothing fits.
 */
export function completeInput(input: string, folders: readonly PickEntry[]): string {
  const { dir, prefix } = splitInput(input);
  const names = folders
    .filter((f) => f.kind === 'dir' && f.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((f) => f.name);
  if (names.length === 0) return input;
  let common = names[0];
  for (const name of names.slice(1)) {
    let n = 0;
    while (n < common.length && n < name.length && common[n].toLowerCase() === name[n].toLowerCase()) n++;
    common = common.slice(0, n);
  }
  // Never shorten what was typed (the typed spelling wins when the listing only differs in case).
  const completed = common.length >= prefix.length ? common : prefix;
  const base = dir === '' ? '' : withSeparator(dir);
  return base + completed + (names.length === 1 && completed.length === names[0].length ? '\\' : '');
}

/** A name for a new folder: not empty, no path characters, not . or .., not reserved. */
export function folderNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Type a name.';
  if (/[<>:"/\\|?*\x00-\x1f]/.test(trimmed)) return 'A folder name cannot contain  < > : " / \\ | ? *';
  if (/^\.+$/.test(trimmed) || /[. ]$/.test(trimmed)) return 'A folder name cannot end with a dot or a space.';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(trimmed))
    return '"' + trimmed + '" is a reserved name in Windows.';
  return null;
}
