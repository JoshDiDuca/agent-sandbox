import fs from 'node:fs';
import { downloader, githubAsset, type ReleaseAsset } from '../../shared/download/index.js';
import { log } from '../runtime/log.js';

/**
 * A single file download that lands as `file` only when complete (and checksum-verified): a cut-off one never looks
 * finished.
 */
export const downloadFile = async (url: string, file: string, sha256: string | null = null): Promise<void> => {
  const part = file + '.part';
  try {
    await downloader.file(url, part, sha256);
    fs.rmSync(file, { force: true });
    fs.renameSync(part, file);
  } finally {
    fs.rmSync(part, { force: true });
  }
};

interface GithubInstall {
  /** The folder the archive is unpacked into (replaced atomically). */
  dest: string;
  /** What the progress line says is being downloaded, with its size; a function gets the release asset. */
  what: string | ((asset: ReleaseAsset) => string);
  /** Look past the latest release for a matching asset. */
  searchOlder?: boolean;
  /** downloader.archive's `locate` / `up`: keep only the folder holding this file. */
  locate?: string;
  up?: number;
}

/** The newest GitHub release asset matching `pattern`, checksum-verified, unpacked into `dest`. */
export const installFromGithub = async (repo: string, pattern: RegExp, o: GithubInstall): Promise<void> => {
  const asset = await githubAsset(repo, pattern, o.searchOlder);
  log('Downloading ' + (typeof o.what === 'string' ? o.what : o.what(asset)) + ' ...');
  await downloader.archive(asset.url, o.dest, {
    sha256: asset.sha256,
    fileName: asset.name,
    ...(o.locate ? { locate: o.locate } : {}),
    ...(o.up ? { up: o.up } : {}),
  });
};
