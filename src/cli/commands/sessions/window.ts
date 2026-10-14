import { requireOnPc, requireRunning, type Context } from '../context.js';
import { SandboxService } from '../../services/index.js';
import { useSharedSandbox } from '../shared-use.js';

export async function show(ctx: Context): Promise<number> {
  requireOnPc('show');
  requireRunning();
  await useSharedSandbox(ctx, { kind: 'owner-only', what: 'show the window', window: true });
  new SandboxService(ctx).showWindow();
  return 0;
}

export async function hide(ctx: Context): Promise<number> {
  requireOnPc('hide');
  requireRunning();
  await useSharedSandbox(ctx, { kind: 'owner-only', what: 'hide the window', window: true });
  await new SandboxService(ctx).hideWindow();
  console.log('Sandbox window hidden. Bring it back with: sbx-show');
  return 0;
}
