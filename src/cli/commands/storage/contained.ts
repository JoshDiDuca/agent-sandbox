// `sandbox storage contained on|off|status` (beta): keep the data set's tools, state and logs in a
// disk image that is mounted only while a sandbox runs. The work is in host/storage/contained; this file asks, shows
// size and time, and prints.
import fs from 'node:fs';
import { userConfigPath } from '../../../core/config/index.js';
import { humanBytes } from '../../../core/disk.js';
import { askRequired } from '../../../core/prompt.js';
import { fail } from '../../../core/util/index.js';
import { isSandboxRunning, realContainedDeps } from '../../../host/sandbox/index.js';
import {
  assertTargetsFree,
  containedAvailability,
  ContainedStorage,
  describeDuration,
  describeSize,
  planTransfer,
  runTransfer,
  setStateOf,
  StateFile,
  writeContainedSetting,
  type TransferPlan,
} from '../../../host/storage/index.js';
import { c, printJson, working } from '../../output/index.js';
import type { Context } from '../context.js';

const BETA = 'Beta, and not yet tested on a real PC. ';

function storageFor(ctx: Context): ContainedStorage {
  const { config } = ctx.loaded;
  return new ContainedStorage(
    realContainedDeps(ctx.storageRoot, config.storage.containedMaxGb),
    config.storage.dataName,
  );
}

function requireAvailable(): void {
  const check = containedAvailability();
  if (!check.available) fail('Contained storage cannot be used: ' + check.reasons.join(' '), check.fixes.join(' '));
}

function requireNoSandbox(): void {
  if (isSandboxRunning())
    fail('A sandbox is running.', 'Close it (sandbox stop) first: the folders in the image are in use.');
}

async function status(ctx: Context): Promise<number> {
  const storage = storageFor(ctx);
  const check = containedAvailability();
  const state = new StateFile(storage.paths).read();
  const record = setStateOf(state, storage.set);
  const reality = check.available && storage.imageExists() ? await storage.reality() : null;
  const answer = {
    setting: ctx.loaded.config.storage.contained,
    maxGb: ctx.loaded.config.storage.containedMaxGb,
    available: check.available,
    reasons: check.reasons,
    image: storage.paths.image,
    imageExists: storage.imageExists(),
    imageBytes: reality?.imageBytes ?? null,
    mountFolder: storage.paths.mount,
    recordedMounted: record.mounted,
    holders: record.holders.length,
    mountedNow: reality?.mountIsMountPoint ?? null,
  };
  if (printJson(ctx, answer)) return 0;
  console.log(c.yellow('Contained storage (beta, untested on a real PC)'));
  console.log('  setting:      storage.contained = ' + answer.setting + ' (limit ' + answer.maxGb + ' GB)');
  console.log(
    '  this PC:      ' +
      (check.available ? 'can use it' : 'cannot use it: ' + check.reasons.join(' ') + ' ' + check.fixes.join(' ')),
  );
  console.log(
    '  image:        ' +
      answer.image +
      (answer.imageExists ? ' (' + humanBytes(answer.imageBytes ?? 0) + ' on disk)' : ' (not made yet)'),
  );
  console.log('  mount folder: ' + answer.mountFolder);
  if (reality)
    console.log(
      '  mounted now:  ' +
        (reality.mountIsMountPoint ? 'yes' : 'no') +
        (record.mounted !== reality.mountIsMountPoint
          ? ' (the record says ' + (record.mounted ? 'yes' : 'no') + '; sandbox doctor looks into it)'
          : ''),
    );
  console.log('\nTurn it on with: sandbox storage contained on   Turn it off with: sandbox storage contained off');
  return 0;
}

function printPlan(plan: TransferPlan, to: string): void {
  for (const f of plan.folders) console.log('  ' + f.name + ': ' + describeSize(f.measured));
  console.log('  total: ' + describeSize(plan.total) + ' to ' + to);
  console.log(
    '  time:  about ' + describeDuration(plan.estimate.seconds) + ' (copied, then the originals are removed)',
  );
  if (!plan.estimate.fits) fail('Not enough free space for the copy.', 'Free some space on that drive and try again.');
}

async function turnOn(ctx: Context): Promise<number> {
  requireAvailable();
  requireNoSandbox();
  const storage = storageFor(ctx);
  const { config } = ctx.loaded;
  const configFile = ctx.loaded.configPath ?? userConfigPath();
  console.log(c.yellow(BETA + 'Contained storage keeps the sandbox tools, state and logs in one disk image file.'));
  console.log('  image:  ' + storage.paths.image + (storage.imageExists() ? ' (exists, it is used as it is)' : ''));
  console.log(
    '  limit:  ' + config.storage.containedMaxGb + ' GB (storage.containedMaxGb; the file grows only as it fills)',
  );
  console.log('  Windows asks for permission to mount it each time a sandbox starts (and once when it closes).');
  if (
    !ctx.options.yes &&
    !(await askRequired('Turn contained storage on?', 'Add --yes to turn it on without asking.', true))
  )
    return fail('Nothing was changed.', 'Run sandbox storage contained on when you want it.');
  const mount = await working('Making and mounting the image (Windows asks for permission)', () =>
    storage.acquire({ id: 'cli', pid: process.pid }, { create: true }),
  );
  try {
    const plan = planTransfer(ctx.dataPath, mount, ctx.storageRoot);
    if (plan.folders.length > 0) {
      console.log('\nThese folders hold your tools, state and logs now:');
      printPlan(plan, 'the image');
      assertTargetsFree(plan);
      const move =
        ctx.options.yes || (await askRequired('Move them into the image?', 'Add --yes to move without asking.', true));
      if (move) {
        let line = 'Copying';
        const result = await working(
          () => line,
          () =>
            runTransfer(plan, ctx.dataPath, (p) => {
              line = 'Copying: ' + p.files.toLocaleString('en-US') + ' files, ' + humanBytes(p.bytes);
            }),
        );
        console.log('Moved ' + result.files.toLocaleString('en-US') + ' files into the image.');
        for (const note of result.notes) console.log(c.yellow(note));
      } else
        console.log(
          'They stay where they are and are not used: tools are downloaded again into the image. Delete them later with sandbox data clean.',
        );
    }
    writeContainedSetting(configFile, 'vhdx');
  } finally {
    const done = await working('Dismounting the image (Windows asks for permission)', () => storage.release('cli'));
    if (!done.dismounted)
      console.log(c.yellow('The image stays mounted (' + (done.note ?? '') + '). sandbox repair dismounts it.'));
  }
  console.log('Contained storage is on. sandbox launch mounts the image first.');
  return 0;
}

async function turnOff(ctx: Context): Promise<number> {
  requireAvailable();
  requireNoSandbox();
  const storage = storageFor(ctx);
  const configFile = ctx.loaded.configPath ?? userConfigPath();
  console.log(c.yellow(BETA + 'Turning contained storage off moves the files back into plain folders.'));
  if (!storage.imageExists()) {
    writeContainedSetting(configFile, 'off');
    console.log('There is no image, so there was nothing to move. Contained storage is off.');
    return 0;
  }
  const mount = await working('Mounting the image (Windows asks for permission)', () =>
    storage.acquire({ id: 'cli', pid: process.pid }),
  );
  let moved = false;
  try {
    const plan = planTransfer(mount, ctx.dataPath, ctx.dataPath);
    if (plan.folders.length > 0) {
      console.log('\nIn the image:');
      printPlan(plan, ctx.dataPath);
      assertTargetsFree(plan);
      if (
        !ctx.options.yes &&
        !(await askRequired('Move them back out of the image?', 'Add --yes to move without asking.', true))
      )
        return fail('Nothing was moved.', 'Contained storage is still on.');
      let line = 'Copying';
      const result = await working(
        () => line,
        () =>
          runTransfer(plan, mount, (p) => {
            line = 'Copying: ' + p.files.toLocaleString('en-US') + ' files, ' + humanBytes(p.bytes);
          }),
      );
      console.log('Moved ' + result.files.toLocaleString('en-US') + ' files back.');
      for (const note of result.notes) console.log(c.yellow(note));
    }
    writeContainedSetting(configFile, 'off');
    moved = true;
  } finally {
    const done = await working('Dismounting the image (Windows asks for permission)', () => storage.release('cli'));
    if (!done.dismounted)
      console.log(c.yellow('The image stays mounted (' + (done.note ?? '') + '). sandbox repair dismounts it.'));
    else if (!moved) console.log('The image was dismounted; contained storage is still on.');
  }
  console.log('Contained storage is off: tools, state and logs are plain folders in ' + ctx.dataPath + '.');
  const bytes = fs.statSync(storage.paths.image).size;
  if (
    !ctx.options.yes &&
    (await askRequired(
      'Delete the image file now (' + humanBytes(bytes) + ')? Everything in it was moved out.',
      'Answer no to keep it.',
      false,
    ))
  ) {
    await storage.deleteImage();
    console.log('Deleted ' + storage.paths.image + '.');
  } else console.log('The image file is kept: ' + storage.paths.image + ' (delete it yourself when you are sure).');
  return 0;
}

/** `sandbox storage contained [status|on|off]`. */
export function contained(ctx: Context): Promise<number> {
  const [, mode = 'status'] = ctx.options.positionals;
  switch (mode) {
    case 'status':
      return status(ctx);
    case 'on':
      return turnOn(ctx);
    case 'off':
      return turnOff(ctx);
    default:
      return Promise.resolve(
        fail(
          'Unknown action "' + mode + '" for contained storage.',
          'Use: sandbox storage contained on, off or status',
        ),
      );
  }
}
