// The one way this tool deletes a folder tree. A recursive delete that resolved to the wrong place (an empty
// variable, a relative path, a planted link) must never be able to take a user profile, a drive or Windows with it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertTestWritable } from './test-guard.js';

const norm = (p: string): string =>
  path
    .resolve(p)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
const isAncestorOrSame = (parent: string, child: string): boolean => {
  const a = norm(parent);
  const b = norm(child);
  return a === b || b.startsWith(a + path.sep);
};

/** Folders no delete may ever reach, or contain: profiles, Windows, program folders. */
const protectedFolders = (): string[] =>
  [
    os.homedir(),
    process.env.USERPROFILE,
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Desktop'),
    process.env.SystemRoot,
    process.env.WINDIR,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
    'C:\\Users',
    'C:\\Windows',
  ].filter((p): p is string => typeof p === 'string' && p.trim() !== '');

/** Folders nothing of ours lives in, so nothing below them may be deleted either. */
const systemFolders = (): string[] =>
  [
    process.env.SystemRoot,
    process.env.WINDIR,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter((p): p is string => typeof p === 'string' && p.trim() !== '');

/**
 * Why `target` may not be deleted, or null when it may. Refused: a relative path, a drive root, a protected folder or
 * any folder that contains one, and anything that is not strictly inside `root`.
 */
export const removeRefusal = (target: string, root: string): string | null => {
  if (!target || !path.isAbsolute(target) || !root || !path.isAbsolute(root)) return 'not an absolute path';
  // \\?\C:\Users and \\.\ spell the same folders in a way the checks below would not recognise.
  if (/^[\\/]{2}[?.][\\/]/.test(target) || /^[\\/]{2}[?.][\\/]/.test(root)) return 'a device path (\\\\?\\ or \\\\.\\)';
  const t = norm(target);
  if (t === norm(path.parse(t).root)) return 'a drive root';
  const hit = protectedFolders().find((p) => isAncestorOrSame(t, p));
  if (hit) return 'it is, or contains, ' + hit;
  const system = systemFolders().find((p) => isAncestorOrSame(p, t));
  if (system) return 'it is inside ' + system;
  if (!t.startsWith(norm(root) + path.sep)) return 'it is not inside ' + root;
  return null;
};

/**
 * Deletes `target` (a folder tree or file) only when it is strictly inside `root` and nothing protected; a link is
 * removed itself, never followed. Throws instead of deleting anything else.
 */
export const safeRemove = (target: string, root: string): void => {
  const refusal = removeRefusal(target, root);
  if (refusal) throw new Error('Refusing to delete ' + target + ': ' + refusal);
  assertTestWritable(target);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    try {
      fs.unlinkSync(target);
    } catch {
      fs.rmdirSync(target);
    }
    return;
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 });
};
