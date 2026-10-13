// Sizes and free space on disk, shared by `data`, `repair`, `setup` and the storage cleanup.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';

export const GB = 1024 ** 3;

/** 1536 -> "1.5 KB". */
export const humanBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = bytes <= 0 ? 0 : Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return (i === 0 ? String(bytes) : value.toFixed(value < 10 ? 1 : 0)) + ' ' + units[i];
};

/** Size on disk, never following links or junctions (a link counts as 0, so a planted junction cannot make us walk this PC's disk). */
export const sizeOf = (p: string): number => {
  try {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) return 0;
    if (!stat.isDirectory()) return stat.size;
    return _.sumBy(fs.readdirSync(p, { withFileTypes: true }), (d) =>
      d.isSymbolicLink() ? 0 : sizeOf(path.join(p, d.name)),
    );
  } catch {
    return 0;
  }
};

/** Free bytes on the drive that holds `dir` (which may not exist yet: the nearest existing parent is asked); null if unknown. */
export const freeBytesAt = (dir: string): number | null => {
  let at = path.resolve(dir);
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  try {
    const s = fs.statfsSync(at);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
};

export interface DiskUsage {
  drive: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  holdsStorage: boolean;
}

/** Every local drive's size and free space, and which one holds the sandbox storage. */
export const diskUsage = (storageRoot: string): DiskUsage[] => {
  const storageDrive = path.parse(path.resolve(storageRoot)).root.toUpperCase();
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'
    .split('')
    .map((letter) => letter + ':\\')
    .flatMap((drive): DiskUsage[] => {
      try {
        const s = fs.statfsSync(drive);
        const totalBytes = s.blocks * s.bsize;
        if (!totalBytes) return [];
        return [
          {
            drive,
            totalBytes,
            freeBytes: s.bavail * s.bsize,
            usedBytes: totalBytes - s.bfree * s.bsize,
            holdsStorage: drive.toUpperCase() === storageDrive,
          },
        ];
      } catch {
        return [];
      }
    });
};
