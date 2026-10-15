import { userDir } from '../../../core/config/index.js';
import {
  autoMigrates,
  continuesAfterFailedMigration,
  MigrateService,
  type MigrateContext,
} from '../../services/index.js';
import { askRequired } from '../../../core/prompt.js';
import { c } from '../../output/index.js';
import { errMsg, UserError } from '../../../core/util/index.js';
import { insideSandbox } from '../../../host/sandbox/index.js';
import { holdsData, oldDefaultRoot } from '../../../host/storage/index.js';
import { refreshStorage, type Context } from '../context.js';

/**
 * Where this context keeps the saved settings. Backups go where the data is: an upgrade that has not pinned the old
 * folder yet would otherwise fill the new, empty default folder with them.
 */
function whereOf(ctx: Context): MigrateContext {
  const old = oldDefaultRoot();
  const unpinned = old !== null && !holdsData(ctx.storageRoot) && holdsData(old) && !ctx.loaded.layers?.machine;
  return { storageRoot: unpinned ? old : ctx.storageRoot, userDir: userDir(), configPath: ctx.loaded.configPath };
}

/** `sandbox migrate`: the work, with the service and the output given so a test can drive it. */
export async function runMigrate(
  service: MigrateService,
  options: { readonly dryRun: boolean; readonly restore?: string; readonly yes?: boolean },
  print: (line: string) => void,
): Promise<number> {
  if (options.restore) {
    if (
      !options.yes &&
      !(await askRequired(
        'Put back the files saved in ' + options.restore + '? Your current settings files are replaced.',
        'Add --yes to put them back without asking.',
      ))
    ) {
      print('Nothing was changed.');
      return 1;
    }
    service.restore(options.restore);
    print('Put back the files saved in ' + options.restore + '.');
    return 0;
  }
  if (options.dryRun) {
    const plan = service.plan();
    print(plan.length ? 'Would update:' : 'Nothing to update.');
    for (const line of plan) print('  ' + line);
    return 0;
  }
  const result = await service.run((line) => print(c.dim(line)));
  if (result.applied.length) print('Updated: ' + result.applied.join(', ') + '.');
  else if (!result.postponed.length) print('Nothing to update.');
  if (result.postponed.length) print('Waiting for no sandbox to run: ' + result.postponed.join(', ') + '.');
  return 0;
}

export function migrate(ctx: Context): Promise<number> {
  return runMigrate(
    new MigrateService(whereOf(ctx)),
    { dryRun: ctx.options.dryRun, restore: ctx.options.restore, yes: ctx.options.yes },
    (line) => console.log(line),
  );
}

/**
 * Before a command: brings the settings up to date when the version changed (one small file is read otherwise).
 * A failure stops the command (throws), except for doctor, which prints it and goes on.
 */
export async function migrateBeforeCommand(ctx: Context, command: string): Promise<void> {
  if (!autoMigrates(command, insideSandbox())) return;
  const service = new MigrateService(whereOf(ctx));
  try {
    if (!service.versionChanged()) return;
    const result = await service.run((line) => console.error(c.dim(line)));
    if (result.applied.length) refreshStorage(ctx);
  } catch (e) {
    if (!continuesAfterFailedMigration(command)) throw e;
    const fix = e instanceof UserError && e.fix ? ' ' + e.fix : '';
    console.error(c.red('Error: ') + errMsg(e) + fix);
  }
}
