import crypto from 'node:crypto';
import fs from 'node:fs';
import { isLink } from '../../core/util/index.js';

/** SHA-256 in small chunks: a sandbox can plant a multi-gigabyte "node.exe" to exhaust this PC's memory. */
export const hash = (file: string): string => {
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
};
