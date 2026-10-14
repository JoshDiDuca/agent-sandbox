import { watch } from '../../../sync/index.js';
import { type Context } from '../context.js';

/** The watcher process exits as soon as its work is done: nothing it opened may keep it running after the sandbox. */
export async function watcher(ctx: Context): Promise<void> {
  await watch(ctx.dataPath, {
    restartAfterCrash: ctx.loaded.config.resume.restartAfterCrash,
    entry: ctx.entry,
    config: ctx.options.config,
  });
  process.exit(0);
}
