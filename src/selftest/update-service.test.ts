// `sandbox update` and the automatic update: the service on a managed install in a temp folder (a folder feed instead
// of GitHub, a fake scheduled task), the one-time notice, the command-line options and the task script. Nothing
// touches this PC: no real scheduled task, no real sandbox check.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCli } from '../cli/args.js';
import { describeResult, runUpdate } from '../cli/commands/maintenance/update.js';
import { UpdateService, runsAsSystem, type UpdateTaskPort } from '../cli/services/index.js';
import { InstallLayout, InstallRecordFile, UpdateTask } from '../host/install/index.js';
import { nativeScript } from '../host/native.js';
import { FolderFeed, UpdateLock, updateNotice } from '../host/update/index.js';
import { SYSTEM } from '../shared/system.js';
import { installFirst, publish, runShim } from './support/releases.js';
import type { Harness } from './support/harness.js';
import type { Suite } from './support/suite.js';

/** A scheduled task that only remembers what it was asked. */
class FakeTask implements UpdateTaskPort {
  readonly calls: string[] = [];
  fail = false;
  register(): void {
    if (this.fail) throw new Error('needs admin');
    this.calls.push('register');
  }
  remove(): void {
    if (this.fail) throw new Error('needs admin');
    this.calls.push('remove');
  }
}

async function service(t: Harness): Promise<void> {
  t.section('update service on a managed install');
  const root = t.dir('svc', 'install');
  const feed = t.at('svc', 'feed');
  const userDir = t.dir('svc', 'user');
  const layout = await installFirst(t, root);
  const clock = { at: new Date('2026-10-14T12:00:00Z') };
  const task = new FakeTask();
  let sandbox = false;
  const make = (): UpdateService =>
    new UpdateService(layout, {
      source: new FolderFeed(feed),
      sandboxRunning: () => sandbox,
      task,
      version: '1.0.0',
      userDir,
      now: () => clock.at,
    });
  const svc = make();

  t.check(svc.managed, 'an install with versions\\ is managed');
  t.equal(svc.status().version, '1.0.0', 'status names the active version');
  t.equal(svc.status().autoUpdate, false, 'automatic updates are off by default');

  t.equal((await svc.check()).available, false, 'no feed, no newer version');
  publish(t, feed, '1.0.1', 'good');
  const found = await svc.check();
  t.check(found.available && found.latest?.version === '1.0.1', 'check finds the newer version');
  t.equal(layout.activeVersion(), '1.0.0', 'check changes nothing');
  t.equal(new InstallRecordFile(root).read()?.autoUpdate, false, 'check leaves install.json alone');

  t.section('update service: run, notice, lock');
  sandbox = true;
  const blocked = await svc.run();
  t.equal(blocked?.kind === 'skipped' && blocked.reason, 'sandbox-running', 'a running sandbox stops the update');
  t.equal(layout.activeVersion(), '1.0.0', 'nothing was installed under a running sandbox');
  sandbox = false;

  const held = new UpdateLock(root, () => clock.at).acquire();
  t.check(held !== null, 'the update lock can be taken');
  t.equal(await svc.run(), null, 'a second update while one runs does nothing');
  t.equal(layout.activeVersion(), '1.0.0', 'and installs nothing');
  held?.();
  t.check(!fs.existsSync(path.join(root, 'update.lock')), 'the lock is released');
  fs.writeFileSync(path.join(root, 'update.lock'), JSON.stringify({ pid: 2147483000, at: clock.at.toISOString() }));
  t.check(new UpdateLock(root, () => clock.at).acquire() !== null, 'a lock left by a process that died is taken over');
  fs.rmSync(path.join(root, 'update.lock'));

  t.equal(svc.notice(), null, 'no notice before any update');
  const done = await svc.run();
  t.equal(done?.kind === 'installed' && done.version, '1.0.1', 'run installs the newer version');
  t.equal(runShim(layout), '1.0.1', 'the shim runs it');
  t.check(!fs.existsSync(path.join(root, 'update.lock')), 'the lock is gone after the run');
  const notice = svc.notice();
  t.equal(notice?.text, 'Updated to 1.0.1.', 'the user is told about the update');
  if (notice) svc.markNoticeSeen(notice);
  t.equal(svc.notice(), null, 'and only once');
  t.equal(
    new UpdateService(layout, {
      source: new FolderFeed(feed),
      userDir: t.dir('svc', 'other-user'),
      version: '1.0.1',
    }).notice()?.text,
    'Updated to 1.0.1.',
    'another user is told too',
  );
  t.equal((await svc.run())?.kind === 'skipped', true, 'running again with nothing new installs nothing');

  publish(t, feed, '1.0.2', 'broken');
  clock.at = new Date(clock.at.getTime() + 25 * 3600_000);
  const bad = await svc.run();
  t.equal(bad?.kind === 'failed' && bad.blocked, true, 'a broken release fails and is blocked');
  t.equal(
    svc.notice()?.text,
    'Update to 1.0.2 failed; still on 1.0.1 (sandbox update --rollback, or sandbox update for details).',
    'the failure is announced with how to go back',
  );
  const blockedCheck = await svc.check();
  t.check(!blockedCheck.available && blockedCheck.blocked, 'check says the newer version is blocked');

  t.equal(svc.rollback(), '1.0.0', 'rollback returns the version the update replaced');
  t.equal(runShim(layout), '1.0.0', 'and the shim runs it');

  t.section('update service: automatic updates');
  t.equal(svc.autoUpdateDue(), false, 'off: never due');
  svc.setAuto(true);
  t.equal(task.calls, [], 'a current-user install has no scheduled task to touch');
  t.equal(new InstallRecordFile(root).read()?.autoUpdate, true, 'the setting is in install.json');
  t.equal(svc.autoUpdateDue(), false, 'on, but looked a moment ago: not due');
  clock.at = new Date(clock.at.getTime() + 25 * 3600_000);
  t.equal(svc.autoUpdateDue(), true, 'on and the last look over a day ago: due');
  sandbox = true;
  t.equal(svc.autoUpdateDue(), false, 'never while a sandbox runs');
  sandbox = false;
  svc.setAuto(false);
  t.equal(new InstallRecordFile(root).read()?.autoUpdate, false, 'and off again');
}

function pure(t: Harness): void {
  t.section('update notice and options');
  const state = { lastResult: { version: '1.5.0', ok: true, at: '2026-10-14T03:00:00Z' } };
  t.equal(updateNotice(state, '1.5.0', undefined)?.text, 'Updated to 1.5.0.', 'a success on the current version');
  t.equal(updateNotice(state, '1.5.0', 'ok@2026-10-14T03:00:00Z'), null, 'not shown twice');
  t.equal(updateNotice(state, '1.6.0', undefined), null, 'not shown once another version runs');
  const failedLater = { ...state, failed: { version: '1.6.0', at: '2026-10-15T03:00:00Z', reason: 'x' } };
  t.includes(
    updateNotice(failedLater, '1.5.0', undefined)?.text ?? '',
    'Update to 1.6.0 failed',
    'the newer outcome wins',
  );
  t.equal(
    updateNotice({ failed: { version: '1.4.0', at: '2026-10-15T03:00:00Z', reason: 'x' } }, '1.5.0', undefined),
    null,
    'a failure of an older version is old news',
  );

  t.equal(parseCli(['update', '--auto', 'on']).autoUpdate, 'on', 'update --auto on');
  t.equal(parseCli(['update', '--auto', 'off']).autoUpdate, 'off', 'update --auto off');
  t.equal(parseCli(['update', '--auto', 'on']).auto, false, 'update --auto is not resume --auto');
  t.equal(parseCli(['resume', '--auto']).auto, true, 'resume --auto is still a switch');
  t.equal(parseCli(['resume', '--auto']).autoUpdate, undefined, 'and not an update setting');
  const flags = parseCli(['update', '--check', '--unattended', '--feed', 'C:\\feed']);
  t.check(flags.check && flags.unattended && flags.feed === 'C:\\feed', 'update --check --unattended --feed');
  t.equal(parseCli(['update', '--rollback']).rollback, true, 'update --rollback');

  t.equal(runsAsSystem({ USERNAME: 'PC$' }, 'PC$'), true, 'a machine account is the service account');
  t.equal(runsAsSystem({}, 'SYSTEM'), true, 'SYSTEM is the service account');
  t.equal(runsAsSystem({ USERNAME: 'alice' }, 'alice'), false, 'a person is not');
}

async function command(t: Harness): Promise<void> {
  t.section('sandbox update: what it prints');
  const lines: string[] = [];
  const print = (line: string): void => void lines.push(line);
  const npm = new UpdateService(null, { version: '1.0.0' });
  t.check(!npm.managed && npm.autoUpdateDue() === false && npm.notice() === null, 'an npm install is not managed');
  t.equal(await runUpdate(npm, { check: false, rollback: false, unattended: false }, print), 0, 'npm install: exit 0');
  t.includes(lines.join('\n'), 'npm install -g windows-development-sandbox', 'and it prints the npm command');
  await t.throws(() => npm.setAuto(true), 'installed with npm', 'automatic updates need a managed install');

  const root = t.dir('cmd', 'install');
  const feed = t.at('cmd', 'feed');
  const layout = await installFirst(t, root, 'machine', false);
  const task = new FakeTask();
  const machine = new UpdateService(layout, {
    source: new FolderFeed(feed),
    task,
    sandboxRunning: () => false,
    version: '1.0.0',
  });
  lines.length = 0;
  await runUpdate(machine, { check: false, rollback: false, unattended: false, auto: 'on' }, print);
  t.equal(task.calls, ['register'], '--auto on creates the scheduled task for an all-users install');
  t.equal(new InstallRecordFile(root).read()?.autoUpdate, true, 'and records it in install.json');
  t.equal(machine.autoUpdateDue(), false, 'an all-users install never updates from a CLI start');
  await runUpdate(machine, { check: false, rollback: false, unattended: false, auto: 'off' }, print);
  t.equal(task.calls, ['register', 'remove'], '--auto off removes it');
  task.fail = true;
  await t.throws(() => machine.setAuto(true), 'needs admin', 'a task that cannot be created fails');
  t.equal(new InstallRecordFile(root).read()?.autoUpdate, false, 'and the setting stays off');

  lines.length = 0;
  t.equal(await runUpdate(machine, { check: true, rollback: false, unattended: false }, print), 0, '--check exits 0');
  t.includes(lines.join('\n'), 'newest version (1.0.0)', 'no feed: you have the newest version');
  publish(t, feed, '1.0.1', 'good');
  lines.length = 0;
  await runUpdate(machine, { check: true, rollback: false, unattended: false }, print);
  t.includes(lines.join('\n'), 'Version 1.0.1 is available', '--check names the newer version');

  t.equal(describeResult(null, false).code, 0, 'another update running is not an error');
  t.equal(
    describeResult({ kind: 'skipped', reason: 'sandbox-running', current: '1.0.0' }, false).code,
    1,
    'by hand, a running sandbox is a failure',
  );
  t.equal(
    describeResult({ kind: 'skipped', reason: 'sandbox-running', current: '1.0.0' }, true).code,
    0,
    'unattended, it just waits',
  );
  t.includes(
    describeResult({ kind: 'installed', version: '1.0.1', previous: '1.0.0' }, false).line,
    'from 1.0.0 to 1.0.1',
    'installed: from and to',
  );
  t.equal(
    describeResult({ kind: 'failed', version: '1.0.1', reason: 'x', blocked: true }, false).code,
    1,
    'a failed update exits 1',
  );
}

function script(t: Harness): void {
  t.section('set-update-task.ps1');
  const file = path.join(t.packageRoot, 'native', 'scripts', 'set-update-task.ps1');
  const parse = spawnSync(SYSTEM.powershell(), nativeScript('check-syntax.ps1', ['-Path', file]), {
    encoding: 'utf8',
    windowsHide: true,
  });
  t.equal(parse.status, 0, 'it parses under the PowerShell 5.1 parser' + (parse.stderr ? ': ' + parse.stderr : ''));
  const shim = path.join(t.dir('task'), 'sandbox.cmd');
  fs.writeFileSync(shim, '@echo off\r\n');
  const check = (args: string[]): number | null =>
    spawnSync(SYSTEM.powershell(), nativeScript('set-update-task.ps1', [...args, '-WhatIfOnly']), {
      encoding: 'utf8',
      windowsHide: true,
    }).status;
  const good = check(['-Command', shim]);
  t.check(
    good === 0 || good === 2,
    'a real sandbox.cmd is accepted (2 = this PowerShell is not admin)',
    'exit ' + good,
  );
  if (good === 0) {
    t.equal(check(['-Command', 'sandbox.cmd']), 1, 'a relative path is refused');
    t.equal(check(['-Command', path.join(t.dir('task'), 'missing.cmd')]), 1, 'a missing file is refused');
    t.equal(check(['-Remove']), 0, '-Remove is accepted');
  }
  t.equal(
    UpdateTask.registerArgs(InstallLayout.at(t.at('task', 'root'), 'machine')),
    ['-Command', path.join(t.at('task', 'root'), 'bin', 'sandbox.cmd')],
    'the task runs the shim, not a version folder',
  );
}

export const updateServiceSuite: Suite = {
  name: 'update-service',
  title: 'sandbox update, automatic updates, the update notice',
  run: async (t) => {
    await service(t);
    pure(t);
    await command(t);
    script(t);
  },
};
