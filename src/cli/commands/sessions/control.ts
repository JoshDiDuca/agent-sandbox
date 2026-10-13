import path from 'node:path';
import { askYesNo } from '../../../core/prompt.js';
import { execInSandbox, restartSessions, currentSessions } from '../../../host/channel/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { isWithin } from '../../../shared/paths/index.js';
import { readSandboxStatus } from '../../../shared/channel/index.js';
import { fail, safeText } from '../../../core/util/index.js';
import { requireOnPc, requireRunning, sandboxAlive, type Context } from '../context.js';
import { hereDir, locateHere } from '../projects/index.js';
import { working } from '../../output/index.js';
import { c } from '../../output/index.js';

/** Restarts this folder's project's sessions (--all: every session). */
export const restart = async (ctx: Context): Promise<number> => {
  requireOnPc('restart');
  requireRunning();
  const here = locateHere(ctx, readSandboxStatus(ctx.dataPath));
  const scope = ctx.options.all || !here.project ? undefined : here.project.guest;
  if (!scope && !ctx.options.all)
    console.log(c.dim(hereDir(ctx) + ' is not a project of the running sandbox: restarting every session.'));
  console.log(
    safeText(
      (
        await working('Restarting the agents' + (scope ? ' of ' + here.project?.name : ''), () =>
          restartSessions(ctx.dataPath, ctx.options.harness ?? null, sandboxAlive, scope),
        )
      ).message,
    ),
  );
  return 0;
};

export const stop = async (ctx: Context): Promise<number> => {
  requireOnPc('stop');
  if (!isSandboxRunning()) {
    console.log('No Windows Sandbox is running.');
    return 0;
  }
  const sandbox =
    readSandboxStatus(ctx.dataPath) ?? fail('This sandbox was not started by this tool.', 'Close its window instead.');
  // Stopping ends every project's sessions, not just this folder's: say which, and ask when others would end too.
  const here = locateHere(ctx, sandbox);
  const running = currentSessions(ctx.dataPath);
  const others = running.filter((s) => !(here.guestDir && isWithin(here.project?.guest ?? here.guestDir, s.cwd)));
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
  if (others.length && !ctx.options.yes) {
    // A script must never end other projects' sessions by accident: without a terminal to ask in, it needs --yes.
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    if (!interactive)
      fail(
        others.length + ' of these sessions belong to other projects, so the sandbox was not stopped.',
        'Stop it anyway with: sandbox stop --yes',
      );
    if (!(await askYesNo(others.length + ' of them belong to other projects. Stop the whole sandbox?'))) {
      console.log('Nothing changed.');
      return 1;
    }
  }
  await working('Asking the sandbox to shut down', () =>
    execInSandbox(
      ctx.dataPath,
      ['C:\\Windows\\System32\\shutdown.exe', '/s', '/t', '2'],
      sandbox.guestWorkspace,
      30,
      sandboxAlive,
    ),
  );
  console.log('Sandbox is shutting down; history and claude-mem sync back when it closes.');
  return 0;
};
