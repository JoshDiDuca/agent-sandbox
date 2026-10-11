// Download/extract helpers shared by the host (Windows Terminal pre-download) and the guest (toolchains).
// Node built-ins only, because this file is copied into the sandbox.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
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

export const download = async (url: string, destination: string, expectedSha256?: string | null): Promise<void> => {
  const response = await fetchRetry(url, {}, 3, 20 * 60 * 1000);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  if (expectedSha256 && sha256File(destination) !== expectedSha256.toLowerCase()) { fs.rmSync(destination, { force: true }); throw new Error('Checksum mismatch for ' + url); }
};

export const sha256File = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export interface ReleaseAsset { url: string; name: string; sha256: string | null }

interface GithubRelease { prerelease: boolean; draft: boolean; assets: { name: string; browser_download_url: string; digest?: string }[] }

const toAsset = (asset: GithubRelease['assets'][number]): ReleaseAsset => ({ url: asset.browser_download_url, name: asset.name, sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null });

/**
 * Finds an asset in the latest GitHub release of `repo` (with its published sha256 when available). With
 * `searchOlder`, falls back to the newest stable release that still ships a matching asset (projects drop assets).
 */
export const githubAsset = async (repo: string, pattern: RegExp, searchOlder = false): Promise<ReleaseAsset> => {
  const latest = await fetchJson<GithubRelease>('https://api.github.com/repos/' + repo + '/releases/latest');
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

/** Extracts .zip / .nupkg / .tar.gz with the tar.exe that ships with Windows, falling back to Expand-Archive. */
export const extractArchive = (archive: string, destination: string): void => {
  fs.mkdirSync(destination, { recursive: true });
  let result = spawnSync(SYSTEM.tar(), ['-xf', archive, '-C', destination], { stdio: 'ignore', windowsHide: true });
  if (result.status !== 0 && /\.(zip|nupkg)$/i.test(archive)) {
    const zip = archive.endsWith('.zip') ? archive : archive + '.zip';
    if (zip !== archive) fs.copyFileSync(archive, zip);
    result = spawnSync(SYSTEM.powershell(), ['-NoLogo', '-NoProfile', '-Command', "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + destination.replace(/'/g, "''") + "' -Force"], { stdio: 'ignore', windowsHide: true });
  }
  if (result.status !== 0) throw new Error('Could not extract ' + archive);
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
export const installArchive = async (url: string, destination: string, options: { sha256?: string | null; sha512?: string | null; locate?: string; up?: number; fileName?: string } = {}): Promise<void> => {
  const work = destination + '.staging-' + crypto.randomBytes(3).toString('hex');
  try {
    const archive = path.join(work, options.fileName ?? path.basename(new URL(url).pathname));
    await download(url, archive, options.sha256);
    if (options.sha512 && crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('hex') !== options.sha512.trim().toLowerCase()) throw new Error('Checksum mismatch for ' + url);
    const extracted = path.join(work, 'x');
    extractArchive(archive, extracted);
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
