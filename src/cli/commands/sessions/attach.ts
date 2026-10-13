import { select } from '@inquirer/prompts';
import { SandboxChannel, sessionsFirstIn } from '../../../host/channel/index.js';
import { ProjectRegistry } from '../../../host/projects/index.js';
import { isWithin } from '../../../shared/paths/index.js';
import type { SessionStatus } from '../../../core/types.js';
import { safeText, sleep } from '../../../core/util/index.js';
import { requireOnPc, requireRunning, type Context } from '../context.js';
import { attachHere, readySandbox } from '../launch/index.js';
import { locateHere, type Located } from '../projects/index.js';
import { ago } from '../../output/index.js';
import { projectOf } from './list.js';

/** Asks which session to attach to, this folder's project first (the newest is the default). */
function chooseSession(ctx: Context, running: readonly SessionStatus[], here: Located): Promise<string> {
  const projects = new ProjectRegistry(ctx.storageRoot).read()?.projects ?? [];
  return select({
    message: 'Which session?' + (here.project ? ' (' + here.project.name + ' first)' : ''),
    choices: running.map((s) => ({
      value: s.id,
      name:
        (here.guestDir && isWithin(here.guestDir, s.cwd) ? '* ' : '  ') +
        safeText(s.harness).padEnd(9) +
        ' ' +
        safeText(projectOf(projects, s)).padEnd(16) +
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
  const channel = new SandboxChannel(ctx.dataPath);
  const id = ctx.options.positionals[0];
  if (!id && channel.runningSessions().length === 0) await sleep(1500);
  const here = locateHere(ctx, ready);
  if (id) return attachHere(ctx, channel.pickSession(id));
  // Several sessions: choose, this folder's project first (the newest is the default).
  const running = sessionsFirstIn(channel.runningSessions(), here.guestDir);
  if (running.length > 1 && process.stdin.isTTY && process.stdout.isTTY)
    return attachHere(ctx, channel.pickSession(await chooseSession(ctx, running, here)));
  return attachHere(ctx, channel.pickSession(undefined, here.guestDir));
}
