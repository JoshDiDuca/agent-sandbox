import { hideSandboxWindow, showSandboxWindow } from '../../../host/sandbox/index.js';
import { fail } from '../../../core/util/index.js';
import { requireOnPc, requireRunning, type Context } from '../context.js';

export const show = (ctx: Context): number => {
  requireOnPc('show');
  requireRunning();
  if (!showSandboxWindow(ctx.storageRoot))
    fail('Could not find the Windows Sandbox window.', 'It may still be starting; try again in a few seconds.');
  return 0;
};

export const hide = async (ctx: Context): Promise<number> => {
  requireOnPc('hide');
  requireRunning();
  if (!(await hideSandboxWindow(ctx.storageRoot, 5)))
    fail('Could not find a visible Windows Sandbox window.', 'It may already be hidden (sbx-show brings it back).');
  console.log('Sandbox window hidden. Bring it back with: sbx-show');
  return 0;
};
