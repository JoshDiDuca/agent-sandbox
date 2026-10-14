// `sandbox update` and the automatic update: the service on a managed install in a temp folder (a folder feed instead
// of GitHub, a fake scheduled task), the one-time notice, the command output and the task script. Nothing touches this
// PC: no real scheduled task, no real sandbox check. The Updater itself is tested in update.test.ts.
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
  let sandbox = false;
  const svc = new UpdateService(layout, {
    source: new FolderFeed(feed),
    sandboxRunning: () => sandbox,
    task: new FakeTask(),
    version: '1.0.0',
    userDir,
    now: () => clock.at,
  });

  const emptyCheck = (await svc.check()).available;
  publish(t, feed, '1.0.1', 'good');
  const found = await svc.check();
  t.check(
    svc.managed &&
      svc.status().version === '1.0.0' &&
      svc.status().autoUpdate === false &&
      emptyCheck === false &&
      found.available &&
      found.latest?.version === '1.0.1' &&
      layout.activeVersion() === '1.0.0',
    'a managed install reports its version, automatic updates off by default; check finds a newer version and changes nothing',
  );

  sandbox = true;
  const blocked = await svc.run();
  t.check(
    blocked?.kind === 'skipped' && blocked.reason === 'sandbox-running' && layout.activeVersion() === '1.0.0',
    'a running sandbox stops the update',
  );
  sandbox = false;

  const held = new UpdateLock(root, () => clock.at).acquire();
  const whileHeld = held !== null && (await svc.run()) === null;
  held?.();
  fs.writeFileSync(path.join(root, 'update.lock'), JSON.stringify({ pid: 2147483000, at: clock.at.toISOString() }));
  t.check(
    whileHeld && new UpdateLock(root, () => clock.at).acquire() !== null,
    'a second update while one runs does nothing; a lock left by a process that died is taken over',
  );
  fs.rmSync(path.join(root, 'update.lock'));

  const noticeBefore = svc.notice();
  const done = await svc.run();
  t.check(
    noticeBefore === null && done?.kind === 'installed' && done.version === '1.0.1' && runShim(layout) === '1.0.1',
    'no notice before any update; run installs the newer version',
  );
  const notice = svc.notice();
  if (notice) svc.markNoticeSeen(notice);
  t.check(
    notice?.text === 'Updated to 1.0.1.' &&
      svc.notice() === null &&
      new UpdateService(layout, {
        source: new FolderFeed(feed),
        userDir: t.dir('svc', 'other-user'),
        version: '1.0.1',
      }).notice() !== null,
    'the user is told about the update once; another user is told too',
  );

  publish(t, feed, '1.0.2', 'broken');
  clock.at = new Date(clock.at.getTime() + 25 * 3600_000);
  const bad = await svc.run();
  const blockedCheck = await svc.check();
  t.check(
    bad?.kind === 'failed' &&
      bad.blocked &&
      svc.notice()?.text.includes('Update to 1.0.2 failed') === true &&
      !blockedCheck.available &&
      blockedCheck.blocked,
    'a broken release fails, is blocked and announced',
  );
  t.check(
    svc.rollback() === '1.0.0' && runShim(layout) === '1.0.0',
    'rollback returns the version the update replaced',
  );

  t.section('update service: automatic updates');
  const dueOff = svc.autoUpdateDue();
  svc.setAuto(true);
  const savedOn = new InstallRecordFile(root).read()?.autoUpdate === true;
  const dueSoon = svc.autoUpdateDue();
  clock.at = new Date(clock.at.getTime() + 25 * 3600_000);
  const due = svc.autoUpdateDue();
  sandbox = true;
  t.equal(
    [dueOff, savedOn, dueSoon, due, svc.autoUpdateDue()],
    [false, true, false, true, false],
    'never due while off; the setting is in install.json; not due a moment after a look, due after a day, never while a sandbox runs',
  );
  sandbox = false;
}

function pure(t: Harness): void {
  t.section('update notice and options');
  const state = { lastResult: { version: '1.5.0', ok: true, at: '2026-10-14T03:00:00Z' } };
  const failedLater = { ...state, failed: { version: '1.6.0', at: '2026-10-15T03:00:00Z', reason: 'x' } };
  t.check(
    updateNotice(state, '1.5.0', undefined)?.text === 'Updated to 1.5.0.' &&
      updateNotice(state, '1.5.0', 'ok@2026-10-14T03:00:00Z') === null &&
      updateNotice(state, '1.6.0', undefined) === null &&
      updateNotice(failedLater, '1.5.0', undefined)?.text.includes('Update to 1.6.0 failed') === true,
    'the notice shows a success once on that version; a newer failure wins',
  );
  const flags = parseCli(['update', '--check', '--unattended', '--feed', 'C:\\feed']);
  t.check(
    parseCli(['update', '--auto', 'on']).autoUpdate === 'on' &&
      parseCli(['update', '--auto', 'on']).auto === false &&
      parseCli(['resume', '--auto']).auto === true &&
      parseCli(['resume', '--auto']).autoUpdate === undefined &&
      flags.check &&
      flags.unattended &&
      flags.feed === 'C:\\feed' &&
      parseCli(['update', '--rollback']).rollback,
    'update options parse; update --auto is not resume --auto',
  );
  t.check(
    runsAsSystem({ USERNAME: 'PC$' }, 'PC$') &&
      runsAsSystem({}, 'SYSTEM') &&
      !runsAsSystem({ USERNAME: 'alice' }, 'alice'),
    'the service account is a machine account or SYSTEM, not a person',
  );
}

async function command(t: Harness): Promise<void> {
  t.section('sandbox update: what it prints');
  const lines: string[] = [];
  const print = (line: string): void => void lines.push(line);
  const npm = new UpdateService(null, { version: '1.0.0' });
  const npmAuto = await t.thrownMessage(() => npm.setAuto(true));
  t.check(
    !npm.managed &&
      (await runUpdate(npm, { check: false, rollback: false, unattended: false }, print)) === 0 &&
      lines.join('\n').includes('npm install -g windows-development-sandbox') &&
      npmAuto.includes('installed with npm'),
    'an npm install is not managed, is told the npm command, and cannot turn on automatic updates',
    npmAuto,
  );

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
  await runUpdate(machine, { check: false, rollback: false, unattended: false, auto: 'on' }, print);
  const afterOn = [...task.calls];
  await runUpdate(machine, { check: false, rollback: false, unattended: false, auto: 'off' }, print);
  t.check(
    afterOn.join() === 'register' && task.calls.join() === 'register,remove' && !machine.autoUpdateDue(),
    '--auto on/off creates and removes the scheduled task of an all-users install; it never updates from a CLI start',
  );
  task.fail = true;
  const noAdmin = await t.thrownMessage(() => machine.setAuto(true));
  t.check(
    noAdmin.includes('needs admin') && new InstallRecordFile(root).read()?.autoUpdate === false,
    'a task that cannot be created fails and the setting stays off',
    noAdmin,
  );

  publish(t, feed, '1.0.1', 'good');
  lines.length = 0;
  t.check(
    (await runUpdate(machine, { check: true, rollback: false, unattended: false }, print)) === 0 &&
      lines.join('\n').includes('Version 1.0.1 is available'),
    '--check names the newer version and exits 0',
  );

  const waiting = { kind: 'skipped', reason: 'sandbox-running', current: '1.0.0' } as const;
  t.check(
    describeResult(null, false).code === 0 &&
      describeResult(waiting, false).code === 1 &&
      describeResult(waiting, true).code === 0 &&
      describeResult({ kind: 'installed', version: '1.0.1', previous: '1.0.0' }, false).line.includes(
        'from 1.0.0 to 1.0.1',
      ) &&
      describeResult({ kind: 'failed', version: '1.0.1', reason: 'x', blocked: true }, false).code === 1,
    'exit codes: a running sandbox fails by hand but just waits unattended; a failed update exits 1',
  );
}

function script(t: Harness): void {
  t.section('set-update-task.ps1');
  const file = path.join(t.packageRoot, 'native', 'scripts', 'set-update-task.ps1');
  const parse = spawnSync(SYSTEM.powershell(), nativeScript('check-syntax.ps1', ['-Path', file]), {
    encoding: 'utf8',
    windowsHide: true,
  });
  const shim = path.join(t.dir('task'), 'sandbox.cmd');
  fs.writeFileSync(shim, '@echo off\r\n');
  const check = (args: string[]): number | null =>
    spawnSync(SYSTEM.powershell(), nativeScript('set-update-task.ps1', [...args, '-WhatIfOnly']), {
      encoding: 'utf8',
      windowsHide: true,
    }).status;
  const good = check(['-Command', shim]);
  t.check(
    parse.status === 0 &&
      (good === 0 || good === 2) &&
      (good !== 0 || check(['-Command', 'sandbox.cmd']) === 1) &&
      JSON.stringify(UpdateTask.registerArgs(InstallLayout.at(t.at('task', 'root'), 'machine'))) ===
        JSON.stringify(['-Command', path.join(t.at('task', 'root'), 'bin', 'sandbox.cmd')]),
    'it parses under PowerShell 5.1; a real sandbox.cmd is accepted (2 = not admin), a relative path refused; the task runs the shim',
    'parse ' + parse.status + (parse.stderr ? ': ' + parse.stderr : '') + ', exit ' + good,
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
