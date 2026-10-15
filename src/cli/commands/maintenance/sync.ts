import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { syncBack } from '../../../sync/index.js';
import { nextStep } from '../../output/index.js';
import { type Context } from '../context.js';

export function sync(ctx: Context): number {
  const running = isSandboxRunning();
  const result = syncBack(ctx.dataPath, !running);
  console.log(
    'History: ' +
      result.history +
      ' item(s) synced back. claude-mem: ' +
      result.claudeMem +
      (running ? ' (claude-mem syncs when the sandbox closes)' : ''),
  );
  nextStep('sandbox claude   (carry on where you left off)');
  return 0;
}
