import _ from 'lodash';
import { describePrune, pruneStorage } from '../../../host/storage/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import { type Context } from '../context.js';

export const clean = (ctx: Context): number => {
  const running = isSandboxRunning() ? new RunDir(ctx.dataPath).readSandboxStatus()?.launchId : undefined;
  console.log(
    'Cleanup: ' +
      describePrune(pruneStorage(ctx.storageRoot, { launchDays: ctx.options.days, keep: _.compact([running]) })),
  );
  return 0;
};
