import { watch } from '../../../sync/index.js';
import { type Context } from '../context.js';

export const watcher = (ctx: Context): Promise<void> => watch(ctx.dataPath);
