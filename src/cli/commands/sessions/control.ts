import path from 'node:path';
import { askYesNo } from '../../../core/prompt.js';
import type { SessionStatus } from '../../../core/types.js';
import { fail, safeText } from '../../../core/util/index.js';
import { requireOnPc, requireRunning, type Context } from '../context.js';
import { working, c } from '../../output/index.js';
import { SandboxService, SessionsService } from '../../services/index.js';

/** Restarts this folder's project's sessions (--all: every session). */
export async function restart(ctx: Context): Promise<number> {
  requireOnPc('restart');
  requireRunning();
  const service = new SessionsService(ctx);
  const scope = service.restartScope(Boolean(ctx.options.all));
  if (scope.notAProject)
    console.log(c.dim(scope.folder + ' is not a project of the running sandbox: restarting every session.'));
  console.log(
    safeText(
      await working('Restarting the agents' + (scope.guest ? ' of ' + scope.projectName : ''), () =>
        service.restart(ctx.options.harness ?? null, scope.guest),
      ),
    ),
  );
  return 0;
}

/**
 * Stopping ends every project's sessions: other projects' sessions need a yes (or --yes). A script must never end them
 * by accident, so without a terminal to ask in it fails.
 */
async function othersMayEnd(ctx: Context, others: readonly SessionStatus[]): Promise<boolean> {
  if (!others.length || ctx.options.yes) return true;
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive)
    fail(
      others.length + ' of these sessions belong to other projects, so the sandbox was not stopped.',
      'Stop it anyway with: sandbox stop --yes',
    );
  return askYesNo(others.length + ' of them belong to other projects. Stop the whole sandbox?');
}

export async function stop(ctx: Context): Promise<number> {
  requireOnPc('stop');
  const service = new SandboxService(ctx);
  if (!service.isRunning()) {
    console.log('No Windows Sandbox is running.');
    return 0;
  }
  // Stopping ends every project's sessions, not just this folder's: say which, and ask when others would end too.
  const { sandbox, running, others } = service.stopPlan();
  if (running.length)
    console.log(
      'Stopping ends ' +
        running.length +
        ' session(s): ' +
        running
          .map((s) => safeText(s.harness) + ' in ' + safeText(s.project ?? path.win32.basename(s.cwd)))
          .join(', ') +
        '.',
    );
  if (!(await othersMayEnd(ctx, others))) {
    console.log('Nothing changed.');
    return 1;
  }
  await working('Asking the sandbox to shut down', () => service.shutdown(sandbox));
  console.log('Sandbox is shutting down; history and claude-mem sync back when it closes.');
  return 0;
}
