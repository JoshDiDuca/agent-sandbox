import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeRemove } from '../io/index.js';
import { fetchRetry } from './http.js';
import { extractArchive, findFile, moveIntoPlace, stagingFolder } from './archive.js';

/** Expected checksums of a download; any that are given must match. */
export interface Checksums {
  sha256?: string | null;
  sha512?: string | null;
}

export interface ArchiveOptions extends Checksums {
  /** Keep only the folder holding this file. */
  locate?: string;
  /** Folders above `locate`'s to keep. */
  up?: number;
  fileName?: string;
  members?: string[];
}

export class Downloader {
  /** downloads.requireChecksum: refuse anything without an expected hash. The guest sets it from session.json. */
  requireChecksum = false;

  /**
   * Streams a download to disk, hashing as it goes: big archives (PostgreSQL is ~330 MB) never sit in memory, and the
   * event loop stays free so other toolchains keep downloading meanwhile. A mismatch (or any failure) leaves no file behind.
   */
  async file(url: string, destination: string, expected: string | null | Checksums = null): Promise<void> {
    const sums: Checksums = typeof expected === 'string' || expected === null ? { sha256: expected } : expected;
    if (this.requireChecksum && !sums.sha256?.trim() && !sums.sha512?.trim()) {
      throw new Error(
        'Refusing to download ' +
          path.basename(destination) +
          ' (' +
          url +
          '): no checksum is published for it, and downloads.requireChecksum is on. Turn that setting off to allow downloads that cannot be verified.',
      );
    }
    const response = await fetchRetry(url, {}, 3, 20 * 60 * 1000);
    if (!response.body) throw new Error('Empty response for ' + url);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // Only the hashes that will be checked (sha512 of a 330 MB archive is not free).
    const checks = (['sha256', 'sha512'] as const).flatMap((kind) => {
      const want = sums[kind]?.trim().toLowerCase();
      return want ? [{ want, hash: crypto.createHash(kind) }] : [];
    });
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        for (const c of checks) c.hash.update(chunk);
        done(null, chunk);
      },
    });
    // Written to <destination>.part and moved into place only once complete and verified, so an interrupted download
    // never leaves a partial file under the real name.
    const partial = destination + '.part';
    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        tap,
        fs.createWriteStream(partial),
      );
      if (checks.some((c) => c.hash.digest('hex') !== c.want)) throw new Error('Checksum mismatch for ' + url);
      // Mapped folders refuse rename-over, so the old file goes first.
      fs.rmSync(destination, { force: true });
      fs.renameSync(partial, destination);
    } finally {
      fs.rmSync(partial, { force: true });
    }
  }

  /**
   * Downloads + extracts into `destination` atomically (staging folder, then rename). With `locate`, only the folder
   * holding that file is kept (`up` folders above it, e.g. locate ruby.exe with up 1 keeps the folder around bin).
   */
  async archive(url: string, destination: string, options: ArchiveOptions = {}): Promise<void> {
    const work = stagingFolder(destination);
    try {
      const archive = path.join(work, options.fileName ?? path.basename(new URL(url).pathname));
      await this.file(url, archive, { sha256: options.sha256, sha512: options.sha512 });
      const extracted = path.join(work, 'x');
      await extractArchive(archive, extracted, options.members);
      let root = extracted;
      if (options.locate) {
        const found = findFile(extracted, options.locate);
        if (!found) throw new Error(options.locate + ' not found in ' + url);
        root = path.dirname(found);
        for (let i = 0; i < (options.up ?? 0) && path.dirname(root).startsWith(extracted); i++)
          root = path.dirname(root);
      }
      moveIntoPlace(root, destination);
    } finally {
      safeRemove(work, path.dirname(work));
    }
  }
}

/** The one downloader of this process. */
export const downloader = new Downloader();
