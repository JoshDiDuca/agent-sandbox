import { watch } from '../../../sync/index.js';
import { type Context } from '../context.js';

export function watcher(ctx: Context): Promise<void> {
  return watch(ctx.dataPath);
}
