// Upgrade migrations: the record of what ran, backups and their restore, the runner's order and failure handling, and
// the first migration (unpinning old defaults). Everything works in temp folders the harness creates.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { DEFAULTS, loadConfig } from '../core/config/index.js';
import {
  MIGRATIONS,
  MigrationBackup,
  MigrationMarker,
  MigrationRunner,
  type Migration,
  type MigrationContext,
} from '../host/migrate/index.js';
import { DEFAULTS_SNAPSHOTS } from '../host/migrate/snapshots.js';
import type { Suite } from './support/suite.js';

interface ConfigShape {
  sandbox: { memoryMb?: unknown };
  toolchains?: { python?: { enabled?: unknown } };
}

const readText = (file: string): string => fs.readFileSync(file, 'utf8');

export const migrateSuite: Suite = {
  name: 'migrate',
  title: 'upgrade migrations: record, backups, runner, unpinned defaults',
  run: async (t) => {
    t.section('the record of what ran');
    const userDir = t.dir('user');
    const marker = new MigrationMarker(userDir);
    t.equal(marker.read(), { lastVersion: '0.0.0', applied: [] }, 'a missing record means nothing has run yet');
    marker.record('first-change', null);
    marker.record('second-change', t.at('backups', 'one'));
    marker.setVersion('1.5.0');
    t.check(marker.has('first-change') && !marker.has('third-change'), 'record and has');
    t.equal(
      marker.read().applied.map((entry) => [entry.id, entry.backup]),
      [
        ['first-change', null],
        ['second-change', t.at('backups', 'one')],
      ],
      'the record keeps the order and the backup of each change',
    );
    t.equal(marker.read().lastVersion, '1.5.0', 'setVersion keeps the list of applied changes');
    await t.throws(() => marker.record('Not Kebab', null), 'kebab-case', 'a change id must be kebab-case');
    t.write(marker.file, '{"lastVersion": 5}');
    await t.throws(() => marker.read(), 'not readable', 'an unreadable record stops the run instead of re-running');

    t.section('backups');
    const storage = t.dir('storage');
    const file = t.write(t.at('work', 'config.json'), '{ // keep\n  "a": 1 }\n');
    const folder = t.at('work', 'folder');
    t.write(path.join(folder, 'deep', 'b.bin'), 'nested file');
    t.write(path.join(folder, 'c.txt'), 'c');
    const fresh = t.at('work', 'new.txt');
    const backup = MigrationBackup.create(storage, '1.0.5', '1.5.0');
    backup.save([file, folder, fresh]);
    fs.writeFileSync(file, 'changed by the migration');
    fs.rmSync(folder, { recursive: true, force: true });
    fs.writeFileSync(fresh, 'made by the migration');
    backup.restore();
    t.equal(readText(file), '{ // keep\n  "a": 1 }\n', 'a file is restored byte for byte');
    t.equal(readText(path.join(folder, 'deep', 'b.bin')), 'nested file', 'a folder is restored with its files');
    t.check(!fs.existsSync(fresh), 'a path that did not exist before the backup is removed on restore');
    t.check(backup.path.startsWith(path.join(storage, 'backups')), 'backups live under <storage root>\\backups');
    const second = MigrationBackup.create(storage, '1.0.5', '1.5.0');
    t.check(second.path !== backup.path, 'two backups in the same second get different folders');
    await t.throws(
      () => second.save([path.join(storage, 'data', 'set', 'x.db')]),
      'data sets are never copied',
      'a data set is refused, never copied',
    );
    const real = t.write(t.at('work2', 'real.txt'), 'real');
    const link = t.at('work2', 'link.txt');
    fs.symlinkSync(real, link, 'file');
    await t.throws(() => second.save([link]), 'is a link', 'a link planted in the way is refused');
    await t.throws(
      () => MigrationBackup.open(storage, t.at('elsewhere')),
      'not a backup folder',
      'restore only accepts folders under the storage root backups',
    );

    t.section('runner: order, failure, retry, postponed');
    let sandboxUp = false;
    const ctx = (userFolder: string, configPath: string | null = null): MigrationContext => ({
      storageRoot: storage,
      userDir: userFolder,
      configPath,
      sandboxRunning: () => sandboxUp,
    });
    const fake = (
      id: string,
      target: string,
      content: string,
      options: { fail?: boolean; needsIdleSandbox?: boolean } = {},
    ): Migration => ({
      id,
      introducedIn: '1.5.0',
      scope: 'user',
      needsIdleSandbox: options.needsIdleSandbox ?? false,
      summary: 'fake ' + id,
      applies: () => true,
      touches: () => [target],
      run: async (_ctx, note) => {
        fs.writeFileSync(target, content);
        note('changed ' + id);
        if (options.fail) throw new Error('disk full');
      },
    });

    const runDir = t.dir('user-runner');
    const target = t.write(t.at('run', 'a.txt'), 'a0');
    const other = t.write(t.at('run', 'b.txt'), 'b0');
    const first = fake('first-change', target, 'a1');
    const broken = fake('second-change', other, 'b1', { fail: true });
    const runner = new MigrationRunner([first, broken], ctx(runDir), new MigrationMarker(runDir));
    t.equal(
      runner.pending().map((m) => m.id),
      ['first-change', 'second-change'],
      'pending changes run in list order',
    );
    t.equal(
      runner.planText(),
      ['first-change: fake first-change', 'second-change: fake second-change'],
      'a dry run lists one line per pending change',
    );
    await t.throws(
      () => runner.run('1.5.0', () => undefined),
      'Updating your saved settings failed (second-change): disk full',
      'a failing change stops the run with the change named',
    );
    await t.throws(
      () => runner.run('1.5.0', () => undefined),
      'Your files are back as they were',
      'and says how to recover',
    );
    t.equal(readText(target), 'a1', 'the change before the failure stays applied');
    t.equal(readText(other), 'b0', "the failing change's files are back as they were");
    t.check(
      new MigrationMarker(runDir).has('first-change') && !new MigrationMarker(runDir).has('second-change'),
      'the record keeps the change that worked and not the one that failed',
    );
    t.equal(new MigrationMarker(runDir).read().lastVersion, '0.0.0', 'the version stays old until everything works');
    const retry = new MigrationRunner(
      [first, fake('second-change', other, 'b2')],
      ctx(runDir),
      new MigrationMarker(runDir),
    );
    t.equal(
      retry.pending().map((m) => m.id),
      ['second-change'],
      'a retry runs only what did not work',
    );
    const done = await retry.run('1.5.0', () => undefined);
    t.equal(done.applied, ['second-change'], 'the retry applies it');
    t.equal(new MigrationMarker(runDir).read().lastVersion, '1.5.0', 'and the version moves on');
    await t.throws(() => runner.restore(t.at('elsewhere')), 'not a backup folder', 'restore refuses other folders');

    const idleDir = t.dir('user-idle');
    const cPath = t.at('run', 'c.txt');
    sandboxUp = true;
    const idleRunner = new MigrationRunner(
      [fake('idle-only', cPath, 'c1', { needsIdleSandbox: true })],
      ctx(idleDir),
      new MigrationMarker(idleDir),
    );
    const notes: string[] = [];
    const waited = await idleRunner.run('1.5.0', (line) => notes.push(line));
    t.equal(waited.postponed, ['idle-only'], 'a change that needs an idle sandbox waits while one runs');
    t.check(!fs.existsSync(cPath), 'and nothing is changed while it waits');
    t.includes(notes.join('\n'), 'Postponed idle-only until no sandbox runs.', 'the wait is said out loud');
    sandboxUp = false;
    const later = await idleRunner.run('1.5.0', () => undefined);
    t.equal(later.applied, ['idle-only'], 'it runs on the next start with no sandbox');

    t.section('unpin-config-defaults');
    const unpin = MIGRATIONS.find((m) => m.id === '2026-10-unpin-config-defaults');
    t.check(unpin !== undefined, 'the first migration is registered');
    const old = DEFAULTS_SNAPSHOTS.find((s) => s.version === '1.0.0');
    t.check(old !== undefined, 'the 1.0.0 defaults snapshot exists');
    if (!unpin || !old) return;

    const configPath = t.at('home', 'config.json');
    const mine = JSON.parse(JSON.stringify(old.defaults)) as { sandbox: Record<string, unknown> };
    mine.sandbox.memoryMb = 8192;
    t.write(configPath, '// my config, written by an old config init\n' + JSON.stringify(mine, null, 2) + '\n');
    const unpinCtx = ctx(t.at('home'), configPath);
    t.check(unpin.applies(unpinCtx), 'an old full config.json that pins defaults needs the migration');
    t.check(!unpin.applies(ctx(t.at('home'), null)), 'no config file: nothing to do');
    const partial = t.write(t.at('partial', 'config.json'), '{"toolchains":{"python":{"enabled":true}}}');
    t.check(!unpin.applies(ctx(t.at('partial'), partial)), 'a partial file (not a full config init) is left alone');
    const current = t.write(t.at('current', 'config.json'), JSON.stringify(DEFAULTS, null, 2));
    t.check(!unpin.applies(ctx(t.at('current'), current)), 'a file with the current defaults needs nothing');

    const notesUnpin: string[] = [];
    await unpin.run(unpinCtx, (line) => notesUnpin.push(line));
    const after = readText(configPath);
    const obj = parse(after) as ConfigShape;
    t.equal(
      obj.toolchains?.python?.enabled,
      undefined,
      'a pinned old default is removed (follows the current default)',
    );
    t.equal(obj.sandbox.memoryMb, 8192, "the user's own value stays");
    t.includes(after, '// my config', 'comments stay');
    t.includes(
      notesUnpin.join('\n'),
      'Now follows the default: toolchains.python.enabled',
      'each removed setting is named',
    );
    t.equal(
      loadConfig(configPath).config.toolchains.python.enabled,
      'auto',
      'the result still loads with the current default',
    );
    t.check(!unpin.applies(unpinCtx), 'running it again finds nothing to do (idempotent)');
  },
};
