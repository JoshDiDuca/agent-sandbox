import { select } from '@inquirer/prompts';
import type { SessionStatus } from '../../../core/types.js';
import { safeText, sleep } from '../../../core/util/index.js';
import { isWithin } from '../../../shared/paths/index.js';
import { requireOnPc, requireRunning, type Context } from '../context.js';
import { attachHere, readySandbox } from '../launch/index.js';
import { locateHere, type Located } from '../projects/index.js';
import { ago } from '../../output/index.js';
import { SessionsService } from '../../services/index.js';

/** Asks which session to attach to, this folder's project first (the newest is the default). */
function chooseSession(service: SessionsService, running: readonly SessionStatus[], here: Located): Promise<string> {
  return select({
    message: 'Which session?' + (here.project ? ' (' + here.project.name + ' first)' : ''),
    choices: running.map((s) => ({
      value: s.id,
      name:
        (here.guestDir && isWithin(here.guestDir, s.cwd) ? '* ' : '  ') +
        safeText(s.harness).padEnd(9) +
        ' ' +
        safeText(service.projectName(s)).padEnd(16) +
        ' ' +
        ago(s.startedAt).padEnd(11) +
        ' ' +
        s.id,
    })),
  });
}

export async function attach(ctx: Context): Promise<number> {
  requireOnPc('attach');
  requireRunning('Start one with: sandbox claude --terminal');
  const ready = await readySandbox(ctx.dataPath);
  const service = new SessionsService(ctx);
  const id = ctx.options.positionals[0];
  if (!id && service.runningCount() === 0) await sleep(1500);
  const here = locateHere(ctx, ready);
  if (id) return attachHere(ctx, service.pick(id));
  // Several sessions: choose, this folder's project first (the newest is the default).
  const running = service.running(here.guestDir);
  if (running.length > 1 && process.stdin.isTTY && process.stdout.isTTY)
    return attachHere(ctx, service.pick(await chooseSession(service, running, here)));
  return attachHere(ctx, service.pick(undefined, here.guestDir));
}
