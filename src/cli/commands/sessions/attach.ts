import { select } from '@inquirer/prompts';
import { SandboxChannel, sessionsFirstIn } from '../../../host/channel/index.js';
import { ProjectRegistry } from '../../../host/projects/index.js';
import { isWithin } from '../../../shared/paths/index.js';
import { safeText, sleep } from '../../../core/util/index.js';
import { requireOnPc, requireRunning, type Context } from '../context.js';
import { attachHere, readySandbox } from '../launch/index.js';
import { locateHere } from '../projects/index.js';
import { ago } from '../../output/index.js';
import { projectOf } from './list.js';

export const attach = async (ctx: Context): Promise<number> => {
  requireOnPc('attach');
  requireRunning('Start one with: sandbox claude --terminal');
  const ready = await readySandbox(ctx.dataPath);
  const id = ctx.options.positionals[0];
  if (!id && new SandboxChannel(ctx.dataPath).runningSessions().length === 0) await sleep(1500);
  const here = locateHere(ctx, ready);
  if (id) return attachHere(ctx, new SandboxChannel(ctx.dataPath).pickSession(id));
  // Several sessions: choose, this folder's project first (the newest is the default).
  const running = sessionsFirstIn(new SandboxChannel(ctx.dataPath).runningSessions(), here.guestDir);
  if (running.length > 1 && process.stdin.isTTY && process.stdout.isTTY) {
    const projects = new ProjectRegistry(ctx.storageRoot).read()?.projects ?? [];
    const chosen = await select({
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
    return attachHere(ctx, new SandboxChannel(ctx.dataPath).pickSession(chosen));
  }
  return attachHere(ctx, new SandboxChannel(ctx.dataPath).pickSession(undefined, here.guestDir));
};
