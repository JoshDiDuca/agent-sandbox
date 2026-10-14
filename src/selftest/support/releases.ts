// Fake releases for the update tests: a tiny package per version whose sandbox.js prints its version (or fails), packed
// with the real tar, offered through a folder feed, and run through the shim with a real cmd.exe.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractArchive } from '../../shared/download/index.js';
import { SYSTEM } from '../../shared/system.js';
import { InstallLayout, writeShims } from '../../host/install/index.js';
import type { Harness } from './harness.js';

export const NODE = 'v22.3.0';
export const SHA_WRONG = '0'.repeat(64);

/** A release tarball: package/package.json and package/dist/bin/sandbox.js, which prints its version (or fails). */
export function packTarball(
  t: Harness,
  version: string,
  behaviour: 'good' | 'broken',
  name = 'windows-development-sandbox',
): string {
  const stage = t.dir('pack', name + '-' + version + '-' + behaviour);
  t.writeJson(path.join(stage, 'package', 'package.json'), {
    name,
    version,
    bin: { sandbox: 'dist/bin/sandbox.js' },
  });
  const body =
    behaviour === 'good'
      ? "if (process.argv.includes('--version')) console.log('" + version + "');"
      : "console.error('broken build'); process.exit(1);";
  t.write(path.join(stage, 'package', 'dist', 'bin', 'sandbox.js'), body + '\n');
  const tgz = t.at('pack', name + '-' + version + '-' + behaviour + '.tgz');
  const made = spawnSync(SYSTEM.tar(), ['-czf', tgz, '-C', stage, 'package'], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error('could not pack the test release: ' + made.stderr);
  return tgz;
}

/** Makes `version` the feed's latest release (feed.json points at its tarball). */
export function publish(
  t: Harness,
  feed: string,
  version: string,
  behaviour: 'good' | 'broken',
  sha?: string,
  name?: string,
): void {
  const tgz = packTarball(t, version, behaviour, name);
  const file = 'windows-development-sandbox-' + version + '.tgz';
  fs.mkdirSync(feed, { recursive: true });
  fs.copyFileSync(tgz, path.join(feed, file));
  const hash = sha ?? crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  t.writeJson(path.join(feed, 'feed.json'), { version, file, sha256: hash });
}

/**
 * A managed install with version 1.0.0 active, made by hand the way the installer does: a private Node (a link to this
 * process's node.exe), the pointers, the shims and install.json.
 */
export async function installFirst(
  t: Harness,
  root: string,
  scope: 'user' | 'machine' = 'user',
  autoUpdate = false,
): Promise<InstallLayout> {
  const layout = InstallLayout.at(root, scope);
  const nodeExe = layout.nodeExe(NODE);
  fs.mkdirSync(path.dirname(nodeExe), { recursive: true });
  try {
    fs.linkSync(process.execPath, nodeExe);
  } catch {
    fs.copyFileSync(process.execPath, nodeExe);
  }
  await extractArchive(packTarball(t, '1.0.0', 'good'), layout.versionDir('1.0.0'));
  layout.setActive('1.0.0', NODE);
  writeShims(layout, { sandbox: 'dist/bin/sandbox.js' });
  t.writeJson(path.join(root, 'install.json'), {
    scope,
    groupSid: null,
    autoUpdate,
    installedAt: '2026-10-01T00:00:00Z',
  });
  return layout;
}

/** What a user gets by running the command: the shim, through cmd.exe. */
export function runShim(layout: InstallLayout): string {
  const shim = path.join(layout.binDir, 'sandbox.cmd');
  const run = spawnSync(SYSTEM.cmd(), ['/d', '/s', '/c', '""' + shim + '" --version"'], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    windowsHide: true,
  });
  return (run.stdout ?? '').trim() + (run.status === 0 ? '' : ' (exit ' + run.status + ')');
}
