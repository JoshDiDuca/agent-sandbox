// `sandbox storage`: where everything kept between sandboxes lives, moving it to another folder (with the size, an
// estimate and a warning first) and switching to a folder without moving. The work is in host/storage.
import fs from 'node:fs';
import path from 'node:path';
import { userConfigPath, userDir } from '../../../core/config/index.js';
import { diskUsage, humanBytes } from '../../../core/disk.js';
import { askChoice, askName, askRequired } from '../../../core/prompt.js';
import { expandPath, fail } from '../../../core/util/index.js';
import {
  describeDuration,
  describeSize,
  estimate,
  holdsData,
  measureFolder,
  mountedSets,
  moveWarning,
  otherDataFolders,
  sharedDefaultRoot,
  StorageHistory,
  StorageMove,
  type Measured,
  type MoveResult,
} from '../../../host/storage/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { protectPrivateFolder } from '../../../host/sharing/index.js';
import { watcherRunning } from '../../../sync/index.js';
import { printJson, working } from '../../output/index.js';
import { requireOnPc, type Context } from '../context.js';
import { contained } from './contained.js';

/** Why a move cannot start (a background sync is still on a data folder in the old storage), or null. */
export function storageBusy(root: string): string | null {
  const mounted = mountedSets(root);
  if (mounted.length > 0)
    return (
      'The contained storage of "' +
      mounted.join('", "') +
      '" is mounted (a disk image; moving now would reach into it).'
    );
  const data = path.join(root, 'data');
  try {
    for (const name of fs.readdirSync(data))
      if (watcherRunning(path.join(data, name))) return 'The background sync of "' + name + '" is still finishing.';
  } catch {
    // no data folder: nothing runs
  }
  return null;
}

function mover(ctx: Context): StorageMove {
  return new StorageMove(
    ctx.loaded.configPath ?? userConfigPath(),
    () => storageBusy(ctx.storageRoot),
    isSandboxRunning,
    protectPrivateFolder,
  );
}

/** The path as typed (variables and ~ expand, relative to the current folder). */
function typedPath(value: string): string {
  return expandPath(value, process.cwd());
}

/** The folder typed, or picked from the default folder, folders that hold data and the drives (or typed in). */
async function folderOf(ctx: Context, value: string | undefined, what: string): Promise<string> {
  if (value) return typedPath(value);
  const fix = 'Use: sandbox storage ' + what + ' <folder>';
  const typed = 'type';
  const known = [sharedDefaultRoot(), ...otherDataFolders(ctx.storageRoot, new StorageHistory(userDir()))];
  const drives = diskUsage(ctx.storageRoot)
    .filter((d) => !d.holdsStorage)
    .map((d) => path.join(d.drive, 'AgentSandbox'));
  const choices = [...new Set([...known, ...drives])]
    .filter((f) => f.toLowerCase() !== ctx.storageRoot.toLowerCase())
    .map((f) => ({ name: f, value: f }));
  const picked = await askChoice('Which folder?', [...choices, { name: 'Type a path...', value: typed }], fix);
  if (picked !== typed) return picked;
  const answer = await askName('Folder:', fix, (v) => v.length > 0 || 'Type a folder path.');
  return typedPath(answer);
}

async function show(ctx: Context): Promise<number> {
  const history = new StorageHistory(userDir());
  const measured = await working(
    'Measuring your saved data (big folders take a moment)',
    () => measureFolder(ctx.storageRoot),
    !ctx.options.json,
  );
  const others = otherDataFolders(ctx.storageRoot, history);
  const shared = sharedDefaultRoot();
  if (
    printJson(ctx, {
      root: ctx.storageRoot,
      exists: fs.existsSync(ctx.storageRoot),
      ...measured,
      defaultRoot: shared,
      otherFoldersWithData: others,
    })
  )
    return 0;
  const inUse = shared.toLowerCase() === ctx.storageRoot.toLowerCase() ? ' (in use)' : '';
  console.log('Your saved data is in: ' + ctx.storageRoot);
  console.log('  ' + (holdsData(ctx.storageRoot) ? describeSize(measured) : 'nothing in it yet'));
  console.log('The default folder is: ' + shared + inUse);
  for (const other of others) console.log('Another folder with data: ' + other);
  console.log(
    '\nMove it with: sandbox storage move <folder>  (or switch without moving: sandbox storage use <folder>)',
  );
  console.log('What takes the space: sandbox data');
  return 0;
}

function printPlan(from: string, to: string, measured: Measured, copyOnly: boolean): void {
  const est = estimate(from, to, measured, copyOnly);
  const time = est.sameVolume
    ? 'a few seconds (same drive, nothing is copied)'
    : describeDuration(est.seconds) + ' (copied to another drive)';
  console.log('Move from: ' + from);
  console.log('       to: ' + to);
  console.log('     size: ' + describeSize(measured));
  console.log('     time: ' + time);
  const warning = moveWarning(measured, est);
  if (warning) console.log('Warning: ' + warning);
  if (!est.fits) fail('Not enough free space on the target drive.', 'Free some space or pick another drive.');
}

/** Moves the data with progress on the terminal; remembers both folders. Used by the command and the start offer. */
export async function performMove(ctx: Context, to: string, keepOld: boolean): Promise<MoveResult> {
  const from = ctx.storageRoot;
  const history = new StorageHistory(userDir());
  let line = 'Moving your data';
  const result = await working(
    () => line,
    () =>
      mover(ctx).move(from, to, {
        keepOld,
        onProgress: (p) => {
          line = 'Copying: ' + p.files.toLocaleString('en-US') + ' files, ' + humanBytes(p.bytes);
        },
      }),
  );
  history.remember(from);
  history.remember(to);
  return result;
}

async function move(ctx: Context): Promise<number> {
  const to = await folderOf(ctx, ctx.options.positionals[1], 'move');
  const from = ctx.storageRoot;
  if (!fs.existsSync(from))
    fail('There is nothing to move: ' + from + ' does not exist.', 'Use sandbox storage use ' + to + ' to switch.');
  mover(ctx).validate(from, to);
  const measured = await working('Measuring your saved data', () => measureFolder(from), !ctx.options.json);
  const keepOld = ctx.options.keepOld;
  printPlan(from, to, measured, keepOld);
  if (!ctx.options.yes) {
    if (!(await askRequired('Move your data to ' + to + '?', 'Add --yes to move without asking.', true))) {
      console.log('Nothing was moved.');
      return 1;
    }
  }
  const result = await performMove(ctx, to, keepOld);
  if (printJson(ctx, result)) return 0;
  const left = result.removedOld ? '' : '; the old folder is still at ' + result.from;
  console.log(
    'Moved ' + result.files.toLocaleString('en-US') + ' files. Your data is now in ' + result.to + left + '.',
  );
  for (const note of result.notes) console.log(note);
  console.log('Your settings now point to ' + result.pinned + ', so older versions find the data too.');
  return 0;
}

async function use(ctx: Context): Promise<number> {
  const to = await folderOf(ctx, ctx.options.positionals[1], 'use');
  if (to.toLowerCase() === ctx.storageRoot.toLowerCase()) {
    console.log('That folder is in use already.');
    return 0;
  }
  const busy = storageBusy(ctx.storageRoot);
  if (busy) fail(busy, 'Wait a minute, then try again.');
  const state = holdsData(to)
    ? to + ' is used as it is.'
    : to + ' starts empty: tools, logins and history are set up again.';
  console.log('Warning: your data stays in ' + ctx.storageRoot + '. ' + state);
  if (!ctx.options.yes) {
    if (
      !(await askRequired(
        'Use ' + to + ' from now on, without moving your data?',
        'Add --yes to switch without asking.',
      ))
    ) {
      console.log('Nothing was changed.');
      return 1;
    }
  }
  new StorageHistory(userDir()).remember(ctx.storageRoot);
  mover(ctx).pin(to);
  console.log('Your data is now looked for in ' + to + '. Move it later with: sandbox storage move <folder>');
  return 0;
}

/** `sandbox storage [show|move <folder>|use <folder>]`. */
export function storage(ctx: Context): number | Promise<number> {
  requireOnPc('storage');
  const [action = 'show'] = ctx.options.positionals;
  switch (action) {
    case 'show':
    case 'info':
      return show(ctx);
    case 'move':
      return move(ctx);
    case 'use':
      return use(ctx);
    case 'contained':
      return contained(ctx);
    default:
      return fail(
        'Unknown storage action "' + action + '".',
        'Use: sandbox storage, sandbox storage move <folder>, sandbox storage use <folder> or sandbox storage contained on|off|status',
      );
  }
}
