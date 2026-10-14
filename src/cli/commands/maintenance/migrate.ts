import { userDir } from '../../../core/config/index.js';
import {
  autoMigrates,
  continuesAfterFailedMigration,
  MigrateService,
  type MigrateContext,
} from '../../services/index.js';
import { c } from '../../output/index.js';
import { errMsg, UserError } from '../../../core/util/index.js';
import { insideSandbox } from '../../../host/sandbox/index.js';
import type { Context } from '../context.js';

/** Where this context keeps the saved settings. */
function whereOf(ctx: Context): MigrateContext {
  return { storageRoot: ctx.storageRoot, userDir: userDir(), configPath: ctx.loaded.configPath };
}

/** `sandbox migrate`: the work, with the service and the output given so a test can drive it. */
export async function runMigrate(
  service: MigrateService,
  options: { readonly dryRun: boolean; readonly restore?: string },
  print: (line: string) => void,
): Promise<number> {
  if (options.restore) {
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
    { dryRun: ctx.options.dryRun, restore: ctx.options.restore },
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
    await service.run((line) => console.error(c.dim(line)));
  } catch (e) {
    if (!continuesAfterFailedMigration(command)) throw e;
    const fix = e instanceof UserError && e.fix ? ' ' + e.fix : '';
    console.error(c.red('Error: ') + errMsg(e) + fix);
  }
}
