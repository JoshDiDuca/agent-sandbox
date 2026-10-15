// The data folder: the pin migration and the two that must leave it alone, the move engine (rename, copy, failures),
// the estimate and checks, the offer to move, and the path picker's helpers and screen. Temp folders only.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { DEFAULTS, machineConfigPath } from '../core/config/index.js';
import { MIGRATIONS, type MigrationContext } from '../host/migrate/index.js';
import { DEFAULTS_SNAPSHOTS } from '../host/migrate/snapshots.js';
import {
  describeDuration,
  ensureStorageRoot,
  estimateMove,
  holdsData,
  measureFolder,
  moveProblem,
  moveWarning,
  oldDefaultRoot,
  pinValue,
  planOffer,
  privateFolderOf,
  sharedDefaultRoot,
  StorageHistory,
  StorageMove,
  usersFolder,
  BIG_BYTES,
  type MoveProgress,
} from '../host/storage/index.js';
import { PathPickerScreen } from '../cli/tui/dialogs/path-picker.js';
import {
  completeInput,
  folderNameProblem,
  listFolder,
  narrow,
  parentOf,
  splitInput,
} from '../cli/tui/dialogs/path-listing.js';
import type { Key } from '../cli/tui/index.js';
import type { Harness } from './support/harness.js';
import type { Suite } from './support/suite.js';

const GB = 1024 ** 3;
const readText = (file: string): string => fs.readFileSync(file, 'utf8');
const key = (name: string, text = '', ctrl = false): Key => ({ name, text, ctrl, meta: false, shift: false });

function migration(id: string): (typeof MIGRATIONS)[number] {
  const found = MIGRATIONS.find((m) => m.id === id);
  if (!found) throw new Error('no migration ' + id);
  return found;
}

function ctxOf(userDir: string, configPath: string | null): MigrationContext {
  return { storageRoot: path.join(userDir, 'storage'), userDir, configPath, sandboxRunning: () => false };
}

/** Three files in two levels, 10 + 100 + 1 bytes. */
function makeTree(root: string): void {
  fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), '0123456789');
  fs.writeFileSync(path.join(root, 'sub', 'b.bin'), 'b'.repeat(100));
  fs.writeFileSync(path.join(root, 'sub', 'deep', 'c.txt'), 'c');
}

const noBusy = (): null => null;
const idle = (): boolean => false;

async function pinMigration(t: Harness): Promise<void> {
  t.section('pin-storage-root: nobody loses sight of their data on upgrade');
  const pin = migration('2026-10-pin-storage-root');
  const oldDir = path.join(process.env.LOCALAPPDATA ?? '', 'AgentSandbox');
  const machineFile = machineConfigPath();
  fs.rmSync(oldDir, { recursive: true, force: true });
  const user = t.dir('pin', 'user');
  t.check(
    !pin.applies(ctxOf(user, null)),
    'a fresh install (no config, no old folder) keeps the shared default: nothing to pin',
  );
  fs.mkdirSync(oldDir, { recursive: true });
  t.check(!pin.applies(ctxOf(user, null)), 'an old folder with nothing in it is not data: nothing to pin');
  fs.writeFileSync(path.join(oldDir, 'x.txt'), 'data');
  t.check(pin.applies(ctxOf(user, null)), 'an old folder with data and no config.json: pinned');
  const notes: string[] = [];
  {
    await pin.run(ctxOf(user, null), (line) => notes.push(line));
    const created = path.join(user, 'config.json');
    t.check(
      fs.existsSync(created) &&
        (parse(readText(created)) as { storage: { root: string } }).storage.root === '%LOCALAPPDATA%\\AgentSandbox' &&
        !pin.applies(ctxOf(user, created)) &&
        notes.length === 1,
      'the config is created with storage.root = %LOCALAPPDATA%\\AgentSandbox, and it is applied once',
    );
    const commented = t.write(t.at('pin', 'c.json'), '// mine\n{\n  "sandbox": { "memoryMb": 4096 } // keep\n}\n');
    await pin.run(ctxOf(user, commented), () => undefined);
    const text = readText(commented);
    t.check(
      text.includes('// mine') &&
        text.includes('// keep') &&
        (parse(text) as { sandbox: { memoryMb: number } }).sandbox.memoryMb === 4096 &&
        text.includes('AgentSandbox'),
      'an existing config keeps its comments and values; the pin is added',
    );
    const chosen = t.write(t.at('pin', 'chosen.json'), JSON.stringify({ storage: { root: 'D:\\Mine' } }));
    t.check(!pin.applies(ctxOf(user, chosen)), 'a storage.root the user chose is never replaced');
    const broken = t.write(t.at('pin', 'broken.json'), '{ not json');
    t.check(!pin.applies(ctxOf(user, broken)), 'a config that cannot be read is left alone');
    t.write(machineFile, JSON.stringify({ storage: { root: t.at('machine-data') } }));
    try {
      t.check(
        !pin.applies(ctxOf(user, commented.replace('c.json', 'none.json'))),
        'an all-users install: nothing pinned',
      );
    } finally {
      fs.rmSync(machineFile);
    }

    t.section('unpin-config-defaults and follow-machine-storage leave the pin alone');
    const unpin = migration('2026-10-unpin-config-defaults');
    const old = DEFAULTS_SNAPSHOTS.find((s) => (s.defaults.storage as { root?: string } | undefined)?.root);
    if (!old) return t.check(false, 'a snapshot with a storage.root exists');
    const full = t.write(
      t.at('pin', 'full.json'),
      JSON.stringify({ ...JSON.parse(JSON.stringify(old.defaults)), sandbox: { memoryMb: 4096 } }),
    );
    await unpin.run(ctxOf(user, full), () => undefined);
    const rest = parse(readText(full)) as { storage?: { root?: string }; sandbox?: { memoryMb?: number } };
    t.check(
      rest.storage?.root === (old.defaults.storage as { root: string }).root && rest.sandbox?.memoryMb === 4096,
      'a full old config keeps its pinned storage.root (the old default no longer is the default)',
    );
    t.check(!unpin.applies(ctxOf(user, full)), 'and the migration is then done');

    const follow = migration('2026-10-follow-machine-storage');
    const pinned = t.write(t.at('pin', 'pinned.json'), JSON.stringify({ storage: { root: DEFAULTS.storage.root } }));
    const oldPinned = t.write(t.at('pin', 'oldpinned.json'), JSON.stringify(old.defaults));
    const partial = t.write(
      t.at('pin', 'partial.json'),
      JSON.stringify({ storage: { root: '%LOCALAPPDATA%\\AgentSandbox' } }),
    );
    const shared = t.at('machine-users');
    t.write(machineFile, JSON.stringify({ storage: { root: shared } }));
    try {
      t.check(
        !follow.applies(ctxOf(user, oldPinned)),
        'with an all-users install, a pin that holds the data is kept while the shared folder is empty',
      );
      t.check(follow.applies(ctxOf(user, pinned)), 'a pin of the shared default still follows the machine config');
      t.check(
        !follow.applies(ctxOf(user, partial)),
        'a pin written on its own (not an old full init) is never dropped',
      );
      fs.mkdirSync(shared, { recursive: true });
      fs.writeFileSync(path.join(shared, 'x'), '1');
      t.check(
        follow.applies(ctxOf(user, oldPinned)),
        'once the shared folder has data, the old pin is dropped as before',
      );
    } finally {
      fs.rmSync(machineFile);
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
  }
}

async function moveEngine(t: Harness): Promise<void> {
  t.section('storage move: rename on one drive');
  const root = t.dir('mv');
  const config = t.write(t.at('mv', 'config.json'), '// mine\n{ "sandbox": { "memoryMb": 4096 } }\n');
  const src = t.at('mv', 'src');
  makeTree(src);
  const measured = measureFolder(src);
  t.equal(
    { files: measured.files, bytes: measured.bytes, partial: measured.partial },
    { files: 3, bytes: 111, partial: false },
    'measuring counts files and bytes',
  );
  const mover = new StorageMove(config, noBusy, idle);
  const dst = t.at('mv', 'dst');
  const renamed = await mover.move(src, dst);
  t.check(
    !renamed.copied &&
      renamed.removedOld &&
      !fs.existsSync(src) &&
      measureFolder(dst).files === 3 &&
      fs.readFileSync(path.join(dst, 'sub', 'b.bin'), 'utf8').length === 100,
    'same drive: the folders are renamed, nothing is copied, the old folder is gone',
  );
  const written = readText(config);
  t.check(
    written.includes('// mine') &&
      (parse(written) as { storage: { root: string } }).storage.root === dst &&
      renamed.pinned === dst,
    'storage.root is pinned in the config (the literal path), comments kept',
  );

  t.section('storage move: copy to another drive (forced), progress, keep old');
  const src2 = t.at('mv', 'src2');
  makeTree(src2);
  const progress: MoveProgress[] = [];
  const copied = await mover.move(src2, t.at('mv', 'dst2'), { forceCopy: true, onProgress: (p) => progress.push(p) });
  const last = progress[progress.length - 1];
  t.check(
    copied.copied &&
      copied.files === 3 &&
      copied.bytes === 111 &&
      copied.removedOld &&
      !fs.existsSync(src2) &&
      measureFolder(t.at('mv', 'dst2')).bytes === 111 &&
      last?.files === 3,
    'copy: files and bytes verified, progress reported, the old folder removed',
  );
  const src3 = t.at('mv', 'src3');
  makeTree(src3);
  const kept = await mover.move(src3, t.at('mv', 'dst3'), { keepOld: true });
  t.check(
    kept.copied && !kept.removedOld && measureFolder(src3).files === 3 && kept.notes.join().includes('kept'),
    '--keep-old copies even on one drive and leaves the old folder',
  );

  t.section('storage move: failures leave everything as it was');
  const blocker = t.write(t.at('mv', 'blocker'), 'a file where a folder should be');
  const badConfig = path.join(blocker, 'config.json');
  const failing = new StorageMove(badConfig, noBusy, idle);
  for (const force of [false, true]) {
    const s = t.at('mv', force ? 'fail-copy' : 'fail-rename');
    makeTree(s);
    const target = t.at('mv', force ? 'fail-copy-to' : 'fail-rename-to');
    await t.throws(
      () => failing.move(s, target, { forceCopy: force }),
      /./,
      'a config that cannot be written fails the move',
    );
    t.check(
      measureFolder(s).files === 3 && !fs.existsSync(target),
      (force ? 'copy' : 'rename') + ': the old folder is whole and nothing is left in the target',
    );
  }
  const existing = t.dir('mv', 'empty-target');
  const s4 = t.at('mv', 'fail-existing');
  makeTree(s4);
  await t.throws(
    () => failing.move(s4, existing, { forceCopy: true }),
    /./,
    'a failed copy into an existing empty folder',
  );
  t.check(
    fs.existsSync(existing) && fs.readdirSync(existing).length === 0,
    'the empty folder you gave stays, emptied again',
  );

  t.section('storage move: checks before anything happens');
  const a = t.dir('mv', 'chk', 'a');
  fs.writeFileSync(path.join(a, 'f'), '1');
  await t.throws(
    () => new StorageMove(config, noBusy, () => true).move(a, t.at('mv', 'chk', 'b')),
    'Sandbox is running',
    'refused while a sandbox runs',
  );
  await t.throws(
    () =>
      new StorageMove(config, () => 'The background sync is still finishing.', idle).move(a, t.at('mv', 'chk', 'b')),
    'background sync',
    'refused while the background sync runs',
  );
  t.equal(
    moveProblem(a, path.join(a, 'in'))?.message,
    'The new folder is inside the old one.',
    'the target may not be inside the source',
  );
  t.equal(
    moveProblem(path.join(a, 'in'), a)?.message,
    'The old folder is inside the new one.',
    'the source may not be inside the target',
  );
  t.equal(moveProblem(a, a)?.message, 'Your data is in that folder already.', 'the same folder is refused');
  t.check(moveProblem(a, path.parse(a).root)?.message.includes('whole drive') === true, 'a whole drive is refused');
  const full = t.dir('mv', 'chk', 'full');
  fs.writeFileSync(path.join(full, 'x'), '1');
  t.check(
    moveProblem(a, full)?.message.includes('not empty') === true && moveProblem(a, full, true) === null,
    'a target with files is refused, unless only switching',
  );
  const link = t.at('mv', 'chk', 'link');
  fs.symlinkSync(t.dir('mv', 'chk', 'real'), link, 'junction');
  t.check(moveProblem(a, link)?.message.includes('link') === true, 'a link is refused as a target');
  t.check(moveProblem(a, t.at('mv', 'chk', 'new')) === null, 'a new folder is fine');
  void root;
}

async function privateRoot(t: Harness): Promise<void> {
  t.section('the storage root is created private under the users folder');
  const users = usersFolder();
  const calls: string[] = [];
  const spy = (dir: string): void => {
    calls.push(dir + ':' + fs.readdirSync(dir).length);
  };
  const mine = path.join(users, 'alice');
  fs.rmSync(users, { recursive: true, force: true });
  ensureStorageRoot(mine, spy);
  t.check(
    fs.existsSync(mine) && calls.join() === mine + ':0' && privateFolderOf(mine) === mine,
    'a missing root is created (with the users folder as the user) and made private while empty',
  );
  ensureStorageRoot(mine, spy);
  t.check(calls.length === 2, 'an existing empty root is made private again; ');
  fs.writeFileSync(path.join(mine, 'x'), '1');
  ensureStorageRoot(mine, spy);
  t.check(calls.length === 2, 'a root that holds data is not touched');
  const plain = t.at('plain', 'root');
  ensureStorageRoot(plain, spy);
  t.check(fs.existsSync(plain) && calls.length === 2 && privateFolderOf(plain) === null, 'elsewhere: just created');
  const deep = path.join(users, 'bob', 'sub');
  ensureStorageRoot(deep, spy);
  t.check(
    calls[calls.length - 1] === path.join(users, 'bob') + ':0' && fs.existsSync(deep),
    'a deeper root: the user folder is the private one',
  );
  const failing = (): void => {
    throw new Error('no access');
  };
  await t.throws(
    () => ensureStorageRoot(path.join(users, 'carol'), failing),
    'Could not make',
    'a folder that cannot be made private stops the command',
  );
  const src = t.at('mvp', 'src');
  makeTree(src);
  const seen: string[] = [];
  const config = t.at('mvp', 'config.json');
  const mover = new StorageMove(config, noBusy, idle, (dir) => seen.push(dir + ':' + fs.readdirSync(dir).length));
  const target = path.join(users, 'dave');
  await mover.move(src, target);
  t.check(
    seen[0] === target + ':0' && measureFolder(target).files === 3,
    'a move into the users folder makes the target private before writing',
  );
}

function estimates(t: Harness): void {
  t.section('estimate, warnings and the pinned form');
  const same = estimateMove({ bytes: 50 * GB, files: 400000, partial: false }, true, null);
  t.check(
    same.sameVolume && same.seconds <= 10 && same.fits && same.big,
    'same drive: seconds, always fits, big when big',
  );
  const copy = estimateMove({ bytes: 8 * GB, files: 100000, partial: false }, false, 100 * GB);
  t.check(
    copy.seconds > 250 && copy.seconds < 350 && copy.fits && copy.big,
    '8 GB, 100k files: about 5 minutes (80 MB/s plus a cost per file)',
  );
  const tight = estimateMove({ bytes: 8 * GB, files: 10, partial: false }, false, 8 * GB);
  t.check(
    !tight.fits && (moveWarning({ bytes: 8 * GB, files: 10, partial: false }, tight) ?? '').includes('free'),
    'not enough room: it does not fit, and the warning says so',
  );
  const small = estimateMove({ bytes: 10 * 1024 * 1024, files: 20, partial: false }, false, 100 * GB);
  t.check(
    !small.big && moveWarning({ bytes: 10, files: 1, partial: false }, small) === null,
    'a small move has no warning',
  );
  t.check(
    estimateMove({ bytes: 1, files: 1, partial: false }, false, null).fits,
    'unknown free space is assumed to be enough',
  );
  t.check(BIG_BYTES === 5 * GB, 'big starts at 5 GB');
  t.equal(
    [describeDuration(3), describeDuration(45), describeDuration(180), describeDuration(7200)],
    ['a few seconds', 'about 50 seconds', 'about 3 minutes', 'about 2 hours'],
    'durations are spoken',
  );
  t.equal(pinValue(sharedDefaultRoot()), DEFAULTS.storage.root, 'the shared default is pinned in its %VARIABLE% form');
  const old = oldDefaultRoot();
  t.equal(old ? pinValue(old) : '', '%LOCALAPPDATA%\\AgentSandbox', 'the old default is pinned in its %VARIABLE% form');
  t.equal(pinValue('D:\\Sandbox\\x'), 'D:\\Sandbox\\x', 'any other folder is pinned as the full path');
}

async function offers(t: Harness): Promise<void> {
  t.section('the offer to move');
  const savedProgramData = process.env.ProgramData;
  process.env.ProgramData = t.dir('offer', 'programdata');
  const oldDir = path.join(process.env.LOCALAPPDATA ?? '', 'AgentSandbox');
  fs.rmSync(oldDir, { recursive: true, force: true });
  try {
    const history = new StorageHistory(t.dir('offer', 'user'));
    const shared = sharedDefaultRoot();
    t.check(planOffer(shared, history) === null, 'a fresh install: nothing to offer');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'x'), '1');
    const upgraded = planOffer(oldDir, history);
    t.check(
      upgraded?.from === oldDir && upgraded.to === shared && upgraded.toIsDefault,
      'after an upgrade (pinned to the old folder): offer the shared default',
    );
    const switched = planOffer(shared, history);
    t.check(
      switched?.from === oldDir && switched.to === shared && switched.toIsDefault,
      'after switching to an all-users install (empty shared folder): offer to move the old data there',
    );
    const mine = t.at('offer', 'mine');
    const named = planOffer(mine, history);
    t.check(
      named?.from === oldDir && named.to === mine && !named.toIsDefault,
      'a configured folder that is empty while another holds data: offer to move it there',
    );
    const chosen = t.dir('offer', 'chosen');
    fs.writeFileSync(path.join(chosen, 'y'), '1');
    t.check(planOffer(chosen, history) === null, 'a folder with data that was chosen on purpose is never asked about');
    history.setNotNow();
    t.check(planOffer(oldDir, history) === null, '"Not now" is not asked again at once');
    t.check(history.mayAsk(new Date(Date.now() + 15 * 24 * 3600 * 1000)), '... but after two weeks it is');
    history.setDontAsk();
    t.check(
      planOffer(oldDir, history) === null && !history.mayAsk(new Date(Date.now() + 400 * 24 * 3600 * 1000)),
      '"Don\'t ask again" is final',
    );
    const fresh = new StorageHistory(t.dir('offer', 'user2'));
    fs.rmSync(oldDir, { recursive: true, force: true });
    const earlier = t.dir('offer', 'earlier');
    fs.writeFileSync(path.join(earlier, 'z'), '1');
    fresh.remember(earlier);
    fresh.remember(earlier);
    t.check(
      fresh.read().previous.length === 1 && planOffer(shared, fresh)?.from === earlier,
      'a folder remembered earlier (downgrade, then upgrade) is offered',
    );
    t.check(!holdsData(t.at('offer', 'nowhere')) && holdsData(earlier), 'holdsData: missing is no data');
  } finally {
    if (savedProgramData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = savedProgramData;
    fs.rmSync(oldDir, { recursive: true, force: true });
  }
}

function pickerHelpers(t: Harness): void {
  t.section('path picker: helpers');
  t.equal(splitInput(''), { dir: '', prefix: '' }, 'nothing typed: This PC');
  t.equal(splitInput('C:'), { dir: 'C:\\', prefix: '' }, 'a drive letter is its root');
  t.equal(splitInput('D:\\Sand'), { dir: 'D:\\', prefix: 'Sand' }, 'the last name is the prefix');
  t.equal(splitInput('D:\\Sandbox\\'), { dir: 'D:\\Sandbox\\', prefix: '' }, 'a trailing backslash names the folder');
  t.equal(
    [parentOf('D:\\a\\b'), parentOf('D:\\a'), parentOf('D:\\'), parentOf('')],
    ['D:\\a', 'D:\\', '', ''],
    'up one level; above a drive is This PC',
  );
  const root = t.dir('pick');
  for (const name of ['alpha', 'alpine', 'beta']) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, 'f.txt'), '1');
  fs.symlinkSync(path.join(root, 'alpha'), path.join(root, 'jlink'), 'junction');
  const folders = listFolder(root);
  t.equal(
    folders.entries.map((e) => e.kind + ':' + e.name),
    ['dir:alpha', 'dir:alpine', 'dir:beta', 'link:jlink'],
    'folders only, sorted, links marked',
  );
  t.equal(
    listFolder(root, true).entries.map((e) => e.name),
    ['alpha', 'alpine', 'beta', 'jlink', 'f.txt'],
    'files come last when asked for',
  );
  const capped = listFolder(root, false, 2);
  t.check(capped.entries.length === 2 && capped.more === 2, 'the listing is capped and counts the rest');
  t.check(listFolder(path.join(root, 'nope')).error === 'No such folder', 'a missing folder reports why');
  t.equal(
    narrow(folders.entries, 'al').map((e) => e.name),
    ['alpha', 'alpine'],
    'typing narrows by start',
  );
  t.equal(
    narrow(folders.entries, '', 'ET').map((e) => e.name),
    ['beta'],
    'the filter matches anywhere, ignoring case',
  );
  t.equal(completeInput(root + '\\al', folders.entries), root + '\\alp', 'Tab completes the shared start');
  t.equal(completeInput(root + '\\alph', folders.entries), root + '\\alpha\\', 'a single match gets its backslash');
  t.equal(completeInput(root + '\\zz', folders.entries), root + '\\zz', 'no match: unchanged');
  t.equal(completeInput(root + '\\ALPH', folders.entries), root + '\\alpha\\', 'completion ignores case');
  t.equal(
    [
      folderNameProblem('ok name'),
      folderNameProblem(''),
      folderNameProblem('a:b') !== null,
      folderNameProblem('con') !== null,
      folderNameProblem('x.') !== null,
    ],
    [null, 'Type a name.', true, true, true],
    'folder names are checked',
  );
}

async function pickerScreen(t: Harness): Promise<void> {
  t.section('path picker: the screen');
  const root = t.at('pick');
  const size = { width: 100, height: 30 };
  const text = (s: PathPickerScreen): string => s.render(size).body.join('\n');
  const only =
    (name: string) =>
    (p: string): true | string =>
      p.toLowerCase().endsWith('\\' + name) ? true : 'only ' + name;
  const screen = new PathPickerScreen({ path: ['T'], title: 'Pick', initial: root + '\\', validate: only('new1') });
  const first = text(screen);
  t.check(
    first.includes('alpha') && first.includes('jlink') && !first.includes('f.txt'),
    'it opens on the folders of the start path, links shown, files hidden',
  );
  for (const ch of 'al') await screen.handle(key(ch, ch));
  const narrowed = text(screen);
  t.check(
    narrowed.includes('alpha') && narrowed.includes('alpine') && !narrowed.includes('beta'),
    'typing narrows the list live',
  );
  await screen.handle(key('tab'));
  await screen.handle(key('h', 'h'));
  await screen.handle(key('tab'));
  t.includes(text(screen), root + '\\alpha\\', 'Tab completes the name');
  const shown = screen.render(size);
  t.check(shown.keys.some(([k]) => k === 'tab') && shown.keys.some(([k]) => k === 'esc'), 'the key bar lists the keys');
  const cancelled = await screen.handle(key('escape'));
  t.check(cancelled !== undefined && (cancelled as { done: unknown }).done === undefined, 'Esc cancels');

  const second = new PathPickerScreen({ path: ['T'], title: 'Pick', initial: root + '\\', validate: only('new1') });
  await second.handle(key('down'));
  await second.handle(key('n', 'n'));
  for (const ch of 'new1') await second.handle(key(ch, ch));
  await second.handle(key('return'));
  t.check(fs.existsSync(path.join(root, 'new1')), 'n asks for a name and creates the folder, then opens it');
  const picked = await second.handle(key('s', 's'));
  t.check((picked as { done: string } | undefined)?.done === path.join(root, 'new1'), 's picks the folder shown');
  const nope = new PathPickerScreen({ path: ['T'], title: 'Pick', initial: root + '\\', validate: only('zzz') });
  await nope.handle(key('down'));
  const refused = await nope.handle(key('s', 's'));
  t.check(
    refused === undefined && text(nope).includes('only zzz'),
    'a path the check refuses is not picked and says why',
  );

  // Move onto the link row: names sort alpha, alpine, beta, jlink, new1 -> jlink is the fifth entry after "..".
  const fourth = new PathPickerScreen({ path: ['T'], title: 'Pick', initial: root + '\\' });
  await fourth.handle(key('down'));
  for (let i = 0; i < 4; i++) await fourth.handle(key('down'));
  await fourth.handle(key('return'));
  t.check((fourth.render(size).notice ?? '').includes('link'), 'a link is not opened: a notice says so');
  t.check(!text(fourth).includes('Nothing here'), 'and the folder stays as it was');
}

export const storageSuite: Suite = {
  name: 'storage',
  title: 'data folder: pin migration, move engine, offer, path picker',
  run: async (t) => {
    await pinMigration(t);
    await moveEngine(t);
    await privateRoot(t);
    estimates(t);
    await offers(t);
    pickerHelpers(t);
    await pickerScreen(t);
  },
};
