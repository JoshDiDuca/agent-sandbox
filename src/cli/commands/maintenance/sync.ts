import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { syncBack } from '../../../sync/index.js';
import { type Context } from '../context.js';

export const sync = (ctx: Context): number => {
  const running = isSandboxRunning();
  const result = syncBack(ctx.dataPath, !running);
  console.log(
    'History: ' +
      result.history +
      ' item(s) synced back. claude-mem: ' +
      result.claudeMem +
      (running ? ' (claude-mem syncs when the sandbox closes)' : ''),
  );
  return 0;
};
