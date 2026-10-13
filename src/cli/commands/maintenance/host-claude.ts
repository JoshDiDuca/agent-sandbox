import { hostClaude } from '../../../host/sandbox/index.js';
import { type Context } from '../context.js';

export function claudeHost(ctx: Context): number {
  return hostClaude(ctx.storageRoot, ctx.options.personal, ctx.options.passthrough);
}
