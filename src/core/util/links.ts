import fs from 'node:fs';
import path from 'node:path';
import { assertTestWritable } from '../../shared/test-guard.js';
import { fail } from './errors.js';

/** True if `p` itself is a symlink or junction (lstat; never follows it). */
export const isLink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Removes a symlink or junction itself (never its target). Junctions need rmdir on Windows. */
export const removeLink = (p: string): void => {
  assertTestWritable(p);
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p);
  }
};

/**
 * The sandbox can write anywhere in its data folder, so it could swap a folder for a junction that points at this
 * PC's own disk. Before the host reads, writes or deletes anything under `root`, every existing path component from
 * `root` down to `target` must be a plain folder/file. Throws otherwise.
 */
export const assertNoLinks = (root: string, target: string): void => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail('Refusing to touch ' + target + ': it is outside ' + root);
  let current = path.resolve(root);
  for (const part of ['', ...rel.split(path.sep).filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    if (isLink(current))
      fail('Refusing to touch ' + target + ': ' + current + ' is a link (possible escape attempt from the sandbox).');
  }
};
