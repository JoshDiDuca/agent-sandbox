import { requireOnPc, requireRunning, type Context } from '../context.js';
import { SandboxService } from '../../services/index.js';

export function show(ctx: Context): number {
  requireOnPc('show');
  requireRunning();
  new SandboxService(ctx).showWindow();
  return 0;
}

export async function hide(ctx: Context): Promise<number> {
  requireOnPc('hide');
  requireRunning();
  await new SandboxService(ctx).hideWindow();
  console.log('Sandbox window hidden. Bring it back with: sbx-show');
  return 0;
}
