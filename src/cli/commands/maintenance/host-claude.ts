import { hostClaude } from '../../../host/sandbox/index.js';
import { type Context } from '../context.js';

export const claudeHost = (ctx: Context): number =>
  hostClaude(ctx.storageRoot, ctx.options.personal, ctx.options.passthrough);
