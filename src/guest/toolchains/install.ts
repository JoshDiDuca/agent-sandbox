import fs from 'node:fs';
import { z } from 'zod';
import { downloader, githubAsset, type ReleaseAsset } from '../../shared/download/index.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { log, warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';
import { type ToolEnv, tool } from './tool-env.js';
import { readState } from './state-file.js';

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

/** Runs one installer; a failure is reported and skipped so it never blocks the other toolchains. */
export const step = async (name: string, env: ToolEnv, work: () => Promise<void>): Promise<void> => {
  try {
    await work();
  } catch (e) {
    warn(
      name +
        ' could not be set up and is skipped; everything else still works, and the next start tries again. Reason: ' +
        errMsg(e),
    );
    env.summary.push(name + ': FAILED');
  }
};

// ---- global packages, installed once -------------------------------------------------------------------------------

const installedFile = (): string => tool('installed-packages.json');
const installed = (): Record<string, string> => readState(installedFile(), z.record(z.string(), z.string()), {});

/**
 * Installs each package that is not installed yet (remembered in tools\installed-packages.json under `group`, e.g.
 * "npm@22.11.0"). One failing package is reported and skipped; it is tried again next boot.
 */
export const installOnce = async (
  env: ToolEnv,
  group: string,
  packages: string[],
  install: (pkg: string) => void | Promise<void>,
): Promise<void> => {
  const todo = packages.filter((p) => !installed()[group + ':' + p]);
  for (const pkg of todo) {
    try {
      log('Installing ' + pkg + ' (' + group + ') ...');
      await install(pkg);
      writeJsonAtomic(installedFile(), { ...installed(), [group + ':' + pkg]: new Date().toISOString() });
    } catch (e) {
      warn(
        pkg +
          ' (' +
          group +
          ') could not be installed and is skipped; the next start tries again. Reason: ' +
          errMsg(e),
      );
    }
  }
  const ok = packages.filter((p) => installed()[group + ':' + p]);
  if (ok.length) env.summary.push(group.split('@')[0] + ' packages: ' + ok.join(', '));
};
