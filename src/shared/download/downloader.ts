import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchRetry } from './http.js';

/** Expected checksums of a download; any that are given must match. */
export interface Checksums {
  sha256?: string | null;
  sha512?: string | null;
}

let checksumRequired = false;
/** downloads.requireChecksum: from then on download() refuses anything it has no expected hash for. The guest sets it from session.json. */
export const setChecksumRequired = (on: boolean): void => {
  checksumRequired = on;
};

/**
 * Streams a download to disk, hashing as it goes: big archives (PostgreSQL is ~330 MB) never sit in memory, and the
 * event loop stays free so other toolchains keep downloading meanwhile. A mismatch (or any failure) leaves no file behind.
 */
export const download = async (
  url: string,
  destination: string,
  expected: string | null | Checksums = null,
): Promise<void> => {
  const sums: Checksums = typeof expected === 'string' || expected === null ? { sha256: expected } : expected;
  if (checksumRequired && !sums.sha256?.trim() && !sums.sha512?.trim()) {
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
  // Written to <destination>.part and moved into place only once complete and verified, so an interrupted download never
  // leaves a partial file under the real name.
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
};
