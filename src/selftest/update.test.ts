// The managed install layout, the shims, the update decision and the updater (installs, failures, rollback), all in
// temp folders. The updater runs real packages: a tiny tarball per version whose sandbox.js prints its version, started
// through the shim with a real cmd.exe. Releases come from a folder feed, never from the network.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractArchive } from '../shared/download/index.js';
import { SYSTEM } from '../shared/system.js';
import { InstallLayout, compareVersions, readBins, shimText, writeShims } from '../host/install/index.js';
import { FolderFeed, Updater, UpdateStateFile, decideUpdate, isTooSoon } from '../host/update/index.js';
import type { Suite } from './support/suite.js';
import type { Harness } from './support/harness.js';

const NODE = 'v22.3.0';
const SHA_WRONG = '0'.repeat(64);

/** A release tarball: package/package.json and package/dist/bin/sandbox.js, which prints its version (or fails). */
function packTarball(t: Harness, version: string, behaviour: 'good' | 'broken', name = 'windows-development-sandbox') {
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
function publish(t: Harness, feed: string, version: string, behaviour: 'good' | 'broken', sha?: string, name?: string) {
  const tgz = packTarball(t, version, behaviour, name);
  const file = 'windows-development-sandbox-' + version + '.tgz';
  fs.mkdirSync(feed, { recursive: true });
  fs.copyFileSync(tgz, path.join(feed, file));
  const hash = sha ?? crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  t.writeJson(path.join(feed, 'feed.json'), { version, file, sha256: hash });
}

/** What a user gets by running the command: the shim, through cmd.exe. */
function runShim(layout: InstallLayout): string {
  const shim = path.join(layout.binDir, 'sandbox.cmd');
  const run = spawnSync(SYSTEM.cmd(), ['/d', '/s', '/c', '"' + shim + '" --version'], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    windowsHide: true,
  });
  return (run.stdout ?? '').trim() + (run.status === 0 ? '' : ' (exit ' + run.status + ')');
}

export const updateSuite: Suite = {
  name: 'update',
  title: 'install layout, shims, update decision, updater with rollback',
  run: async (t) => {
    t.section('install layout');
    const root = t.dir('install');
    const layout = InstallLayout.at(root, 'user');
    const detected = InstallLayout.detect(path.join(root, 'versions', '1.2.3', 'package'));
    t.check(detected !== null, 'a managed package folder (versions\\x.y.z\\package) is detected');
    t.equal(detected?.root, root, 'the detected root is the folder above versions\\');
    t.equal(detected?.scope, 'user', 'a root outside Program Files is a per-user install');
    t.equal(
      InstallLayout.detect(t.at('npm', 'lib', 'windows-development-sandbox')),
      null,
      'an npm global (not in versions\\) is not managed',
    );
    t.equal(InstallLayout.detect(t.at('versions', 'x.y', 'package')), null, 'a non-version folder name is not managed');
    t.equal(
      InstallLayout.detect(t.at('versions', '1.2.3', 'dist')),
      null,
      'a folder that is not package is not managed',
    );

    const sorted = InstallLayout.at(t.at('sorted'), 'user');
    for (const v of ['1.10.0', '1.9.0', '1.0.0']) t.dir('sorted', 'versions', v);
    t.dir('sorted', 'versions', '1.11.0.staging');
    t.equal(
      sorted.installedVersions(),
      ['1.0.0', '1.9.0', '1.10.0'],
      'installed versions sort by number, staging ignored',
    );
    t.equal(compareVersions('1.10.0', '1.9.0') > 0, true, 'compareVersions compares numbers, not text');
    await t.throws(() => layout.versionDir('../evil'), 'not a version number', 'a version folder name is checked');
    await t.throws(() => layout.nodeDir('22.3.0'), 'not a Node version', 'a Node folder name is checked');

    // The private Node: a hard link to this process's node.exe (a copy when the volumes differ).
    const nodeExe = layout.nodeExe(NODE);
    fs.mkdirSync(path.dirname(nodeExe), { recursive: true });
    try {
      fs.linkSync(process.execPath, nodeExe);
    } catch {
      fs.copyFileSync(process.execPath, nodeExe);
    }
    // The first install, made by hand (what the installer does): one version, the pointers, the shims.
    const feed = t.at('feed');
    const initial = packTarball(t, '1.0.0', 'good');
    await extractArchive(initial, layout.versionDir('1.0.0'));
    layout.setActive('1.0.0', NODE);
    writeShims(layout, { sandbox: 'dist/bin/sandbox.js' });
    t.equal(layout.activeVersion(), '1.0.0', 'active-version names the installed version');
    t.equal(layout.activeNode(), NODE, 'active-node is written and read back');
    await t.throws(
      () => layout.setActive('9.9.9', NODE),
      'is not installed',
      'setActive refuses a version not installed',
    );
    await t.throws(
      () => layout.setActive('1.0.0', 'v22'),
      'not a Node version',
      'setActive refuses a bad Node version',
    );

    t.section('shims');
    const cmd = shimText('sandbox', 'cmd');
    t.equal(
      cmd,
      [
        '@echo off',
        'setlocal',
        'set /p V=<"%~dp0..\\active-version"',
        'set /p N=<"%~dp0..\\active-node"',
        '"%~dp0..\\node\\%N%\\node.exe" "%~dp0..\\versions\\%V%\\package\\dist\\bin\\sandbox.js" %*',
        '',
      ].join('\r\n'),
      'the cmd shim has the exact text, with CRLF line endings',
    );
    const sh = shimText('sandbox', 'sh');
    t.check(sh.startsWith('#!/bin/sh\n') && !sh.includes('\r'), 'the sh shim is a POSIX script with LF endings');
    t.includes(
      sh,
      'exec "$root/node/$node_version/node.exe" "$root/versions/$version/package/dist/bin/sandbox.js" "$@"',
      'the sh shim execs the active node on the active version, with all arguments',
    );
    t.includes(
      shimText('claude-sandbox', 'cmd', 'dist/bin/claude-sbx.js'),
      'dist\\bin\\claude-sbx.js',
      'a command can point at another program',
    );
    await t.throws(
      () => shimText('bad name;', 'cmd'),
      'not a command name',
      'a shim name must be a plain command name',
    );
    t.equal(
      readBins({ bin: { sandbox: 'dist/bin/sandbox.js' } }),
      { sandbox: 'dist/bin/sandbox.js' },
      'bin names come from package.json',
    );
    await t.throws(
      () => readBins({ bin: { 'a b': 'x.js' } }),
      'invalid name',
      'a bad bin name in package.json is refused',
    );
    t.check(
      fs.existsSync(path.join(layout.binDir, 'sandbox.cmd')) && fs.existsSync(path.join(layout.binDir, 'sandbox')),
      'writeShims writes the cmd and sh shims',
    );

    t.section('the update decision');
    const now = new Date('2026-10-14T12:00:00Z');
    const latest = (version: string) => ({ version, tarball: { url: 'file:///x.tgz', sha256: SHA_WRONG } });
    const base = { current: '1.0.0', now, sandboxRunning: false, minHoursBetweenChecks: 24 };
    const none = { lastCheck: undefined };
    t.equal(
      decideUpdate({ ...base, latest: latest('1.0.1'), state: none }),
      { kind: 'install', release: latest('1.0.1') },
      'a newer release installs',
    );
    t.equal(
      decideUpdate({ ...base, latest: null, state: none }),
      { kind: 'skip', reason: 'no-release' },
      'no release: skip',
    );
    t.equal(
      decideUpdate({ ...base, latest: latest('1.0.0'), state: none }),
      { kind: 'skip', reason: 'up-to-date' },
      'the same version: up to date',
    );
    t.equal(
      decideUpdate({ ...base, latest: latest('0.9.0'), state: none }),
      { kind: 'skip', reason: 'up-to-date' },
      'an older release is never installed',
    );
    t.equal(
      decideUpdate({ ...base, sandboxRunning: true, latest: latest('1.0.1'), state: none }),
      { kind: 'skip', reason: 'sandbox-running' },
      'a running sandbox blocks the update',
    );
    const recent = { lastCheck: new Date(now.getTime() - 3600_000).toISOString() };
    t.equal(
      decideUpdate({ ...base, latest: latest('1.0.1'), state: recent }),
      { kind: 'skip', reason: 'too-soon' },
      'an hour after the last check is too soon',
    );
    t.equal(
      decideUpdate({ ...base, force: true, latest: latest('1.0.1'), state: recent }),
      { kind: 'install', release: latest('1.0.1') },
      'force passes the time gate',
    );
    const failed = { failed: { version: '1.0.2', at: now.toISOString(), reason: 'x' } };
    t.equal(
      decideUpdate({ ...base, latest: latest('1.0.2'), state: failed }),
      { kind: 'skip', reason: 'failed-before' },
      'the version that failed is not retried',
    );
    t.equal(
      decideUpdate({ ...base, latest: latest('1.0.1'), state: failed }),
      { kind: 'skip', reason: 'failed-before' },
      'an older version than the failure is not retried either',
    );
    t.equal(
      decideUpdate({ ...base, latest: latest('1.0.3'), state: failed }),
      { kind: 'install', release: latest('1.0.3') },
      'a newer version than the failure installs',
    );
    t.check(!isTooSoon({ lastCheck: 'not a date' }, now, 24), 'a damaged last-check time does not block updates');

    t.section('updater: install, failure, rollback');
    const clock = { at: new Date('2026-10-14T12:00:00Z') };
    const updater = new Updater(layout, new FolderFeed(feed), {
      now: () => clock.at,
      minHoursBetweenChecks: 0,
    });
    t.equal(runShim(layout), '1.0.0', 'the shim runs the version the pointers name');

    publish(t, feed, '1.0.1', 'good');
    const one = await updater.run({ sandboxRunning: false });
    t.equal(
      one,
      { kind: 'installed', version: '1.0.1', previous: '1.0.0' },
      'a good release installs and becomes active',
    );
    t.equal(layout.activeVersion(), '1.0.1', 'active-version moved to 1.0.1');
    t.equal(runShim(layout), '1.0.1', 'the shim now runs 1.0.1');
    t.equal(new UpdateStateFile(root).read().previous, '1.0.0', 'the replaced version is remembered for a rollback');

    publish(t, feed, '1.0.2', 'broken');
    clock.at = new Date(clock.at.getTime() + 60 * 60 * 1000);
    const bad = await updater.run({ sandboxRunning: false });
    t.check(
      bad.kind === 'failed' && bad.version === '1.0.2' && bad.reason.includes('did not start'),
      'a version that does not start fails with the reason',
      JSON.stringify(bad),
    );
    t.equal(layout.activeVersion(), '1.0.1', 'the active version stays where it was after a failure');
    t.equal(runShim(layout), '1.0.1', 'the shim still runs the working version');
    t.check(!fs.existsSync(layout.versionDir('1.0.2')), 'the failed version is deleted');
    t.equal(new UpdateStateFile(root).read().failed?.version, '1.0.2', 'the failure is recorded');

    const gated = new Updater(layout, new FolderFeed(feed), { now: () => clock.at, minHoursBetweenChecks: 24 });
    t.equal(
      await gated.run({ sandboxRunning: false }),
      { kind: 'skipped', reason: 'too-soon', current: '1.0.1' },
      'a second check within 24 hours does not look again',
    );
    t.equal(
      await gated.run({ sandboxRunning: false, force: true }),
      { kind: 'skipped', reason: 'failed-before', current: '1.0.1' },
      'a forced check skips the version that failed',
    );
    t.equal(
      await updater.run({ sandboxRunning: true }),
      { kind: 'skipped', reason: 'sandbox-running', current: '1.0.1' },
      'a running sandbox is never updated under',
    );

    publish(t, feed, '1.0.3', 'good');
    const three = await updater.run({ sandboxRunning: false });
    t.equal(
      three,
      { kind: 'installed', version: '1.0.3', previous: '1.0.1' },
      'a newer good release after a failure installs',
    );
    t.equal(layout.installedVersions(), ['1.0.1', '1.0.3'], 'only the active and the previous version are kept');

    publish(t, feed, '1.0.4', 'good', undefined, 'some-other-package');
    const named = await updater.run({ sandboxRunning: false });
    t.check(
      named.kind === 'failed' && named.reason.includes('is not windows-development-sandbox'),
      'a release of another package is refused',
      JSON.stringify(named),
    );

    publish(t, feed, '1.0.5', 'good', SHA_WRONG);
    const hash = await updater.run({ sandboxRunning: false });
    t.check(
      hash.kind === 'failed' && hash.reason.includes('Checksum mismatch'),
      'a wrong sha256 is refused before anything is extracted',
      JSON.stringify(hash),
    );
    t.equal(layout.activeVersion(), '1.0.3', 'a refused download changes nothing');
    t.equal(new UpdateStateFile(root).read().failed?.version, '1.0.5', 'a wrong sha256 is recorded as failed');

    t.equal(updater.rollback(), '1.0.1', 'rollback returns the previous version');
    t.equal(layout.activeVersion(), '1.0.1', 'rollback moves the pointers back');
    t.equal(runShim(layout), '1.0.1', 'the shim runs the rolled back version');
    t.equal(new UpdateStateFile(root).read().previous, '1.0.3', 'a second rollback goes forward again');

    publish(t, feed, '1.0.6', 'good');
    const six = await updater.run({ sandboxRunning: false });
    t.equal(six.kind, 'installed', 'a newer release after a rollback installs');
    t.equal(runShim(layout), '1.0.6', 'and the shim runs it');

    t.section('updater: a failed download is retried, not blocked');
    const before = new UpdateStateFile(root).read().failed;
    publish(t, feed, '1.0.7', 'good');
    const tarball = path.join(feed, 'windows-development-sandbox-1.0.7.tgz');
    const copy = t.at('pack', 'kept-1.0.7.tgz');
    fs.copyFileSync(tarball, copy);
    fs.rmSync(tarball);
    const missing = await updater.run({ sandboxRunning: false });
    t.check(
      missing.kind === 'failed' && missing.blocked === false,
      'a download that fails (file missing) is reported and does not block the version',
      JSON.stringify(missing),
    );
    t.equal(new UpdateStateFile(root).read().failed, before, 'a failed download leaves the failure record untouched');
    t.equal(new UpdateStateFile(root).read().lastResult?.ok, false, 'the last result says the attempt failed');
    t.equal(layout.activeVersion(), '1.0.6', 'a failed download changes nothing');
    fs.copyFileSync(copy, tarball);
    const retried = await updater.run({ sandboxRunning: false });
    t.equal(
      retried,
      { kind: 'installed', version: '1.0.7', previous: '1.0.6' },
      'the next run retries the same version and installs it',
    );

    t.section('feed');
    t.equal(await new FolderFeed(t.dir('empty-feed')).latest(), null, 'a folder with no feed.json has no release');
  },
};
