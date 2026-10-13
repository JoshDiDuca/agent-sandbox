import _ from 'lodash';
import { describePrune, pruneStorage } from '../../../host/storage/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { readSandboxStatus } from '../../../shared/channel/index.js';
import { type Context } from '../context.js';

export const clean = (ctx: Context): number => {
  const running = isSandboxRunning() ? readSandboxStatus(ctx.dataPath)?.launchId : undefined;
  console.log(
    'Cleanup: ' +
      describePrune(pruneStorage(ctx.storageRoot, { launchDays: ctx.options.days, keep: _.compact([running]) })),
  );
  return 0;
};
