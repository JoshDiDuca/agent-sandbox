// Where a newer version comes from: the latest GitHub release (the tgz asset and its sha256), or a folder with a
// feed.json (tests, and local builds). Both give the same ReleaseInfo, so the updater does not care which one it has.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { errMsg, fail } from '../../core/util/index.js';
import { fetchText, githubAsset } from '../../shared/download/index.js';
import { JsonFile } from '../../shared/io/index.js';
import { VERSION_PATTERN } from '../install/layout.js';

export const RELEASE_REPO = 'JoshDiDuca/windows-development-sandbox';
const TARBALL = /^windows-development-sandbox-(\d+\.\d+\.\d+)\.tgz$/;
const SHA256 = /^[0-9a-f]{64}$/i;

export interface ReleaseInfo {
  version: string;
  tarball: {
    /** https:// for GitHub, file: for a folder feed. */
    url: string;
    sha256: string;
    /** Bytes, when the source knows them. */
    size?: number;
  };
}

export interface ReleaseSource {
  /** The newest release, or null when there is none. */
  latest(): Promise<ReleaseInfo | null>;
}

/**
 * The latest GitHub release: its windows-development-sandbox-x.y.z.tgz and the sha256 (asset digest, else
 * SHA256SUMS).
 */
export class GithubReleases implements ReleaseSource {
  constructor(private readonly repo: string = RELEASE_REPO) {}

  async latest(): Promise<ReleaseInfo | null> {
    let asset;
    try {
      asset = await githubAsset(this.repo, TARBALL);
    } catch (e) {
      if (errMsg(e).startsWith('No asset matching')) return null;
      throw e;
    }
    const version = TARBALL.exec(asset.name)?.[1];
    if (!version) fail('The release asset ' + asset.name + ' is not a package tarball.');
    const sha256 = asset.sha256 ?? (await this.checksumFrom(asset.name));
    if (!sha256) fail('The release of ' + this.repo + ' publishes no sha256 for ' + asset.name + '.');
    return { version, tarball: { url: asset.url, sha256 } };
  }

  /** The checksum line for `name` in the release's SHA256SUMS asset (for releases whose API has no digest). */
  private async checksumFrom(name: string): Promise<string | null> {
    let sums;
    try {
      sums = await githubAsset(this.repo, /^SHA256SUMS$/);
    } catch {
      return null;
    }
    const text = await fetchText(sums.url);
    for (const line of text.split(/\r?\n/)) {
      const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
      if (match && match[2] === name) return match[1].toLowerCase();
    }
    return null;
  }
}

const FeedSchema = z.object({
  version: z.string().regex(VERSION_PATTERN),
  file: z.string().min(1),
  sha256: z.string().regex(SHA256),
});

/** A release described by <folder>\feed.json ({ version, file, sha256 }) with the tarball next to it. */
export class FolderFeed implements ReleaseSource {
  constructor(private readonly folder: string) {}

  async latest(): Promise<ReleaseInfo | null> {
    const feed = new JsonFile(FeedSchema, path.join(this.folder, 'feed.json')).read();
    if (!feed) return null;
    if (path.basename(feed.file) !== feed.file) fail('feed.json names a file outside its folder: ' + feed.file);
    const file = path.join(this.folder, feed.file);
    if (!fs.existsSync(file)) fail('feed.json names ' + file + ', which does not exist.');
    return {
      version: feed.version,
      tarball: { url: pathToFileURL(file).href, sha256: feed.sha256.toLowerCase(), size: fs.statSync(file).size },
    };
  }
}
