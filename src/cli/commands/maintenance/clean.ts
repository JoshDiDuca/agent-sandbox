// `sandbox clean`: old launch folders, logs and leftovers. Shows what and how much, then asks (--yes skips).
import _ from 'lodash';
import { askRequired } from '../../../core/prompt.js';
import { describePrune, pruneStorage } from '../../../host/storage/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import { nextStep } from '../../output/index.js';
import { type Context } from '../context.js';

export async function clean(ctx: Context): Promise<number> {
  const running = isSandboxRunning() ? new RunDir(ctx.dataPath).readSandboxStatus()?.launchId : undefined;
  const options = { launchDays: ctx.options.days, keep: _.compact([running]) };
  const found = pruneStorage(ctx.storageRoot, { ...options, dryRun: true });
  if (found.launches + found.logs + found.leftovers === 0) {
    console.log('Nothing to clean.');
    return 0;
  }
  console.log('Can be removed: ' + describePrune(found).replace(' removed', '') + '.');
  if (!ctx.options.yes && !(await askRequired('Delete them?', 'Add --yes to delete without asking.'))) {
    console.log('Nothing removed.');
    return 1;
  }
  console.log('Removed ' + describePrune(pruneStorage(ctx.storageRoot, options)).replace(' removed', '') + '.');
  nextStep('sandbox data   (see what else is saved, and clean it)');
  return 0;
}
