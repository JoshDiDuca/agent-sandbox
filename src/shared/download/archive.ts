import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeRemove } from '../io/index.js';
import { SYSTEM } from '../system.js';
import { spawnAsync } from './spawn.js';
import { download } from './downloader.js';

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
    status = await spawnAsync(SYSTEM.powershell(), [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      "Expand-Archive -LiteralPath '" +
        zip.replace(/'/g, "''") +
        "' -DestinationPath '" +
        destination.replace(/'/g, "''") +
        "' -Force",
    ]);
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

/**
 * Downloads + extracts into `destination` atomically (staging folder, then rename). With `locate`, only the folder holding
 * that file is kept (`up` folders above it, e.g. locate ruby.exe with up 1 keeps the folder around bin).
 */
export const installArchive = async (
  url: string,
  destination: string,
  options: {
    sha256?: string | null;
    sha512?: string | null;
    locate?: string;
    up?: number;
    fileName?: string;
    members?: string[];
  } = {},
): Promise<void> => {
  const work = stagingFolder(destination);
  try {
    const archive = path.join(work, options.fileName ?? path.basename(new URL(url).pathname));
    await download(url, archive, { sha256: options.sha256, sha512: options.sha512 });
    const extracted = path.join(work, 'x');
    await extractArchive(archive, extracted, options.members);
    let root = extracted;
    if (options.locate) {
      const found = findFile(extracted, options.locate);
      if (!found) throw new Error(options.locate + ' not found in ' + url);
      root = path.dirname(found);
      for (let i = 0; i < (options.up ?? 0) && path.dirname(root).startsWith(extracted); i++) root = path.dirname(root);
    }
    moveIntoPlace(root, destination);
  } finally {
    safeRemove(work, path.dirname(work));
  }
};
