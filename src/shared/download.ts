// Download/extract helpers shared by the host (Windows Terminal pre-download) and the guest (toolchains).
// Node built-ins only, because this file is copied into the sandbox.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SYSTEM } from './system.js';

const USER_AGENT = 'agent-sandbox';

/** fetch with retries (the sandbox network can take a few seconds to come up) and a timeout per attempt. */
export const fetchRetry = async (url: string, init: RequestInit = {}, attempts = 5, timeoutMs = 60000): Promise<Response> => {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) } });
      if (response.ok) return response;
      last = new Error('HTTP ' + response.status + ' for ' + url);
      if (response.status === 404) break;
    } catch (e) { last = e; }
    if (i < attempts) await new Promise((r) => setTimeout(r, 3000));
  }
  throw last instanceof Error ? last : new Error(String(last));
};

/** Small lookups fail fast (2 tries, 20 s each) so an offline boot falls back to cached versions quickly. */
export const fetchJson = async <T>(url: string): Promise<T> => await (await fetchRetry(url, { headers: { Accept: 'application/json' } }, 2, 20000)).json() as T;
export const fetchText = async (url: string): Promise<string> => await (await fetchRetry(url)).text();

/** Expected checksums of a download; any that are given must match. */
export interface Checksums { sha256?: string | null; sha512?: string | null }

/**
 * Streams a download to disk, hashing as it goes: big archives (PostgreSQL is ~330 MB) never sit in memory, and the
 * event loop stays free so other toolchains keep downloading meanwhile. A mismatch deletes the file.
 */
export const download = async (url: string, destination: string, expected: string | null | Checksums = null): Promise<void> => {
  const sums: Checksums = typeof expected === 'string' || expected === null ? { sha256: expected } : expected;
  const response = await fetchRetry(url, {}, 3, 20 * 60 * 1000);
  if (!response.body) throw new Error('Empty response for ' + url);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const hashes = { sha256: crypto.createHash('sha256'), sha512: crypto.createHash('sha512') };
  const tap = new Transform({ transform(chunk: Buffer, _encoding, done) { hashes.sha256.update(chunk); hashes.sha512.update(chunk); done(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), tap, fs.createWriteStream(destination));
  for (const kind of ['sha256', 'sha512'] as const) {
    const want = sums[kind]?.trim().toLowerCase();
    if (want && hashes[kind].digest('hex') !== want) { fs.rmSync(destination, { force: true }); throw new Error('Checksum mismatch for ' + url); }
  }
};

/** Runs a program without blocking the event loop (parallel downloads keep going); resolves with its exit code. */
export const spawnAsync = (file: string, args: string[], options: import('node:child_process').SpawnOptions = {}): Promise<number> => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, ...options });
  child.once('error', reject);
  child.once('close', (code) => resolve(code ?? -1));
});

export const sha256File = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export interface ReleaseAsset { url: string; name: string; sha256: string | null }

interface GithubRelease { prerelease: boolean; draft: boolean; assets: { name: string; browser_download_url: string; digest?: string }[] }

const toAsset = (asset: GithubRelease['assets'][number]): ReleaseAsset => ({ url: asset.browser_download_url, name: asset.name, sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null });

/**
 * Finds an asset in the latest GitHub release of `repo` (with its published sha256 when available). With
 * `searchOlder`, falls back to the newest stable release that still ships a matching asset (projects drop assets).
 */
export const githubAsset = async (repo: string, pattern: RegExp, searchOlder = false): Promise<ReleaseAsset> => {
  let latest: GithubRelease;
  try { latest = await fetchJson<GithubRelease>('https://api.github.com/repos/' + repo + '/releases/latest'); } catch (e) {
    // The API allows 60 requests an hour per IP without a token; a first boot alone makes a dozen. The release page has
    // the same assets and digests and no such limit.
    if (!/HTTP (403|429)/.test(e instanceof Error ? e.message : '')) throw e;
    return githubAssetFromPage(repo, pattern);
  }
  const hit = latest.assets.find((a) => pattern.test(a.name));
  if (hit) return toAsset(hit);
  if (searchOlder) {
    const releases = await fetchJson<GithubRelease[]>('https://api.github.com/repos/' + repo + '/releases?per_page=100');
    for (const release of releases.filter((r) => !r.prerelease && !r.draft)) {
      const older = release.assets.find((a) => pattern.test(a.name));
      if (older) return toAsset(older);
    }
  }
  throw new Error('No asset matching ' + pattern + ' in the ' + (searchOlder ? 'stable' : 'latest') + ' ' + repo + ' release(s)');
};

/**
 * Extracts .zip / .nupkg / .7z / .tar.gz with the tar.exe that ships with Windows, falling back to Expand-Archive.
 * `members` limits it to those paths inside the archive (e.g. skip pgAdmin in the PostgreSQL zip).
 */
/** The latest release's assets from github.com itself (no API rate limit): each download link, then its sha256. */
export const parseReleasePage = (html: string): ReleaseAsset[] => {
  const links = [...html.matchAll(/href="(\/[^"]+\/releases\/download\/[^"]+)"/g)];
  return links.map((link, i) => {
    const digest = /sha256:([0-9a-f]{64})/.exec(html.slice(link.index, links[i + 1]?.index ?? html.length))?.[1] ?? null;
    return { url: 'https://github.com' + link[1], name: decodeURIComponent(link[1].split('/').pop()!), sha256: digest };
  });
};

/** The latest release's tag, from github.com's own redirect (no API, no rate limit). */
export const latestGithubTag = async (repo: string): Promise<string> => {
  const latest = await fetchRetry('https://github.com/' + repo + '/releases/latest', {}, 2, 20000);
  const tag = decodeURIComponent(latest.url.split('/releases/tag/')[1] ?? '');
  return tag || Promise.reject(new Error('Could not find the latest release of ' + repo));
};

const githubAssetFromPage = async (repo: string, pattern: RegExp): Promise<ReleaseAsset> => {
  const tag = await latestGithubTag(repo);
  const hit = parseReleasePage(await fetchText('https://github.com/' + repo + '/releases/expanded_assets/' + encodeURIComponent(tag))).find((a) => pattern.test(a.name));
  return hit ?? Promise.reject(new Error('No asset matching ' + pattern + ' in ' + repo + ' ' + tag));
};

export const extractArchive = async (archive: string, destination: string, members: string[] = []): Promise<void> => {
  fs.mkdirSync(destination, { recursive: true });
  let status = await spawnAsync(SYSTEM.tar(), ['-xf', archive, '-C', destination, ...members]);
  if (status !== 0 && /\.(zip|nupkg)$/i.test(archive)) {
    const zip = archive.endsWith('.zip') ? archive : archive + '.zip';
    if (zip !== archive) fs.copyFileSync(archive, zip);
    status = await spawnAsync(SYSTEM.powershell(), ['-NoLogo', '-NoProfile', '-Command', "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + destination.replace(/'/g, "''") + "' -Force"]);
  }
  if (status !== 0) throw new Error('Could not extract ' + archive);
};

export const findFile = (root: string, name: string, maxDepth = 4): string | null => {
  if (maxDepth < 0 || !fs.existsSync(root)) return null;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path.join(root, entry.name);
  for (const entry of entries) if (entry.isDirectory()) { const found = findFile(path.join(root, entry.name), name, maxDepth - 1); if (found) return found; }
  return null;
};

/**
 * Downloads + extracts into `destination` atomically (staging folder, then rename). With `locate`, only the folder holding
 * that file is kept (`up` folders above it, e.g. locate ruby.exe with up 1 keeps the folder around bin).
 */
export const installArchive = async (url: string, destination: string, options: { sha256?: string | null; sha512?: string | null; locate?: string; up?: number; fileName?: string; members?: string[] } = {}): Promise<void> => {
  const work = destination + '.staging-' + crypto.randomBytes(3).toString('hex');
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
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(root, destination);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};
