// Fingerprints of the files the guard compares (planted commands, git hooks).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dirExists, isLink } from '../../core/util/index.js';

/** SHA-256 in small chunks: a sandbox can plant a multi-gigabyte "node.exe" to exhaust this PC's memory. */
export function hash(file: string): string {
  if (isLink(file)) return 'link';
  const sum = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1 << 20);
  let fd: number;
  // A file that cannot be read (locked by a program in the sandbox) never matches the snapshot, so it is dealt with.
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return 'unreadable-' + crypto.randomBytes(4).toString('hex');
  }
  try {
    for (
      let n = fs.readSync(fd, buffer, 0, buffer.length, null);
      n > 0;
      n = fs.readSync(fd, buffer, 0, buffer.length, null)
    )
      sum.update(buffer.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return sum.digest('hex');
}

/** The accepted files (and links) directly in a folder, by name, with their fingerprints. Links are not followed. */
export function filesIn(dir: string, accept: (name: string) => boolean): Record<string, string> {
  return dirExists(dir) && !isLink(dir)
    ? Object.fromEntries(
        fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => (e.isFile() || e.isSymbolicLink()) && accept(e.name))
          .map((e) => [e.name, hash(path.join(dir, e.name))]),
      )
    : {};
}
