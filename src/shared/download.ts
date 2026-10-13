// Download/extract helpers shared by the host (Windows Terminal pre-download) and the guest (toolchains).
// Node built-ins only, so it stays small in both bundles (the CLI and the guest runtime).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeRemove } from './safe-remove.js';
import { SYSTEM } from './system.js';

const USER_AGENT = 'windows-development-sandbox';

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

/** fetch with retries (the sandbox network can take a few seconds to come up) and a timeout per attempt. */
export const fetchRetry = async (
  url: string,
  init: RequestInit = {},
  attempts = 5,
  timeoutMs = 60000,
): Promise<Response> => {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
      });
      if (response.ok) return response;
      last = new Error('HTTP ' + response.status + ' for ' + url);
      if (response.status === 404) break;
    } catch (e) {
      last = e;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 3000));
  }
  throw last instanceof Error ? last : new Error(String(last));
};

/** Small lookups fail fast (2 tries, 20 s each) so an offline boot falls back to cached versions quickly. */
export const fetchJson = async <T>(url: string): Promise<T> =>
  (await (await fetchRetry(url, { headers: { Accept: 'application/json' } }, 2, 20000)).json()) as T;
export const fetchText = async (url: string): Promise<string> => await (await fetchRetry(url)).text();

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

/** Runs a program without blocking the event loop (parallel downloads keep going); resolves with its exit code. */
export const spawnAsync = (
  file: string,
  args: string[],
  options: import('node:child_process').SpawnOptions = {},
): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });

export interface ReleaseAsset {
  url: string;
  name: string;
  sha256: string | null;
}

interface GithubRelease {
  prerelease: boolean;
  draft: boolean;
  assets: { name: string; browser_download_url: string; digest?: string }[];
}

const toAsset = (asset: GithubRelease['assets'][number]): ReleaseAsset => ({
  url: asset.browser_download_url,
  name: asset.name,
  sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null,
});

/**
 * Finds an asset in the latest GitHub release of `repo` (with its published sha256 when available). With
 * `searchOlder`, falls back to the newest stable release that still ships a matching asset (projects drop assets).
 */
export const githubAsset = async (repo: string, pattern: RegExp, searchOlder = false): Promise<ReleaseAsset> => {
  let latest: GithubRelease;
  try {
    latest = await fetchJson<GithubRelease>('https://api.github.com/repos/' + repo + '/releases/latest');
  } catch (e) {
    // The API allows 60 requests an hour per IP without a token; a first boot alone makes a dozen. The release page has
    // the same assets and digests and no such limit.
    if (!/HTTP (403|429)/.test(e instanceof Error ? e.message : '')) throw e;
    return githubAssetFromPage(repo, pattern, searchOlder);
  }
  const hit = latest.assets.find((a) => pattern.test(a.name));
  if (hit) return toAsset(hit);
  if (searchOlder) {
    const releases = await fetchJson<GithubRelease[]>(
      'https://api.github.com/repos/' + repo + '/releases?per_page=100',
    );
    for (const release of releases.filter((r) => !r.prerelease && !r.draft)) {
      const older = release.assets.find((a) => pattern.test(a.name));
      if (older) return toAsset(older);
    }
  }
  throw new Error(
    'No asset matching ' + pattern + ' in the ' + (searchOlder ? 'stable' : 'latest') + ' ' + repo + ' release(s)',
  );
};

/** A release's assets from github.com's expanded_assets page (no API rate limit): each download link, then its sha256. */
export const parseReleasePage = (html: string): ReleaseAsset[] => {
  const links = [...html.matchAll(/href="(\/[^"]+\/releases\/download\/[^"]+)"/g)];
  return links.map((link, i) => {
    const digest =
      /sha256:([0-9a-f]{64})/.exec(html.slice(link.index, links[i + 1]?.index ?? html.length))?.[1] ?? null;
    return { url: 'https://github.com' + link[1], name: decodeURIComponent(link[1].split('/').pop()!), sha256: digest };
  });
};

/** The latest release's tag, from github.com's own redirect (no API, no rate limit). */
export const latestGithubTag = async (repo: string): Promise<string> => {
  const latest = await fetchRetry('https://github.com/' + repo + '/releases/latest', {}, 2, 20000);
  const tag = decodeURIComponent(latest.url.split('/releases/tag/')[1] ?? '');
  return tag || Promise.reject(new Error('Could not find the latest release of ' + repo));
};

/** Release tags in the order github.com's /<repo>/releases page lists them (newest first), without duplicates. */
export const parseReleaseTags = (html: string, repo: string): string[] => {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const tags = [...html.matchAll(new RegExp('href="/' + escaped + '/releases/tag/([^"?#]+)"', 'gi'))].map((m) =>
    decodeURIComponent(m[1]),
  );
  return [...new Set(tags)];
};

/** How many releases the rate-limit fallback looks through for `searchOlder` (one page request each). */
const OLDER_RELEASES = 10;

const githubAssetFromPage = async (repo: string, pattern: RegExp, searchOlder: boolean): Promise<ReleaseAsset> => {
  const assetsOf = async (tag: string): Promise<ReleaseAsset | undefined> =>
    parseReleasePage(
      await fetchText('https://github.com/' + repo + '/releases/expanded_assets/' + encodeURIComponent(tag)),
    ).find((a) => pattern.test(a.name));
  const latest = await latestGithubTag(repo);
  const hit = await assetsOf(latest);
  if (hit) return hit;
  // nvm-windows' portable zip and winlibs' builds only exist in older releases: walk the release list like the API path does.
  if (searchOlder) {
    const older = parseReleaseTags(await fetchText('https://github.com/' + repo + '/releases'), repo).filter(
      (t) => t !== latest,
    );
    for (const tag of older.slice(0, OLDER_RELEASES)) {
      const found = await assetsOf(tag);
      if (found) return found;
    }
  }
  throw new Error(
    'No asset matching ' + pattern + ' in ' + repo + ' ' + latest + (searchOlder ? ' or the releases before it' : ''),
  );
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
