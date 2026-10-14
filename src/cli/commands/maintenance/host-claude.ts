import { fail } from '../../../core/util/index.js';
import { hostAgent, hostClaude } from '../../../host/sandbox/index.js';
import { type Context } from '../context.js';

/** `sandbox host-claude` (kept for compatibility): Claude on this PC, not sandboxed. */
export function claudeHost(ctx: Context): number {
  return hostClaude(ctx.storageRoot, ctx.options.personal, ctx.options.passthrough);
}

/** `sandbox host <agent> [-- args]`: the real agent on this PC, not sandboxed. */
export function hostCommand(ctx: Context): number {
  // The agent is the first operand; the rest goes to the agent.
  const [agent, ...args] = ctx.options.passthrough;
  if (!agent) fail('Which agent?', 'Usage: sandbox host <agent> [-- arguments for the agent]');
  return hostAgent(ctx.loaded.config, ctx.storageRoot, agent, ctx.options.personal, args);
}
