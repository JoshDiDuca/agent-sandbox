import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeRemove } from '../io/index.js';
import { SYSTEM } from '../system.js';
import { scriptArgs } from '../scripts.js';
import { spawnAsync } from './spawn.js';

/**
 * A fresh `<destination>.staging-<hex>` folder next to `destination`: fill it, then moveIntoPlace. An interrupted copy
 * or extraction leaves only the staging folder (cleanup/repair remove those), never a half-filled destination.
 */
export const stagingFolder = (destination: string): string =>
  destination + '.staging-' + crypto.randomBytes(3).toString('hex');

/** Replaces `destination` with the finished `work` folder (a folder rename: the destination is never half there). */
export const moveIntoPlace = (work: string, destination: string): void => {
  safeRemove(destination, path.dirname(destination));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(work, destination);
};

/**
 * Extracts .zip / .nupkg / .7z / .tar.gz with the tar.exe that ships with Windows, falling back to Expand-Archive.
 * `members` limits it to those paths inside the archive (e.g. skip pgAdmin in the PostgreSQL zip).
 */
export const extractArchive = async (archive: string, destination: string, members: string[] = []): Promise<void> => {
  fs.mkdirSync(destination, { recursive: true });
  let status = await spawnAsync(SYSTEM.tar(), ['-xf', archive, '-C', destination, ...members]);
  if (status !== 0 && /\.(zip|nupkg)$/i.test(archive)) {
    const zip = archive.endsWith('.zip') ? archive : archive + '.zip';
    if (zip !== archive) fs.copyFileSync(archive, zip);
    status = await spawnAsync(
      SYSTEM.powershell(),
      scriptArgs('expand-archive.ps1', ['-Archive', zip, '-Destination', destination]),
    );
  }
  if (status !== 0) throw new Error('Could not extract ' + archive);
};

export const findFile = (root: string, name: string, maxDepth = 4): string | null => {
  if (maxDepth < 0 || !fs.existsSync(root)) return null;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries)
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path.join(root, entry.name);
  for (const entry of entries)
    if (entry.isDirectory()) {
      const found = findFile(path.join(root, entry.name), name, maxDepth - 1);
      if (found) return found;
    }
  return null;
};
