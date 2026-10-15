// The sessions feature's work: the list (as this user may see it under the sharing rules) and restarting the agents.
import { safeText } from '../../../core/util/index.js';
import { hostEndpoint } from '../../../host/channel/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { requireOnPc, requireRunning } from '../../../cli/commands/context.js';
import { lookAtSandbox, useSharedSandbox } from '../../../cli/commands/shared-use.js';
import { SessionsService, type ListedSession } from '../../../cli/services/index.js';
import { implement, typedConfirm } from '../../context.js';
import { cancelled } from '../../kernel/index.js';
import { listSessions, restartSessions, type SessionRow } from './sessions.def.js';

/** A listed session as the surfaces see it: no attach address or token, text from the sandbox made safe. */
function sessionRow(s: ListedSession): SessionRow {
  const { attach: _attach, ...rest } = s;
  return {
    ...rest,
    harness: safeText(s.harness),
    cwd: safeText(s.cwd),
    ...(s.project !== undefined ? { project: safeText(s.project) } : {}),
    message: safeText(s.message).slice(0, 300),
    ...(s.conversation !== undefined ? { conversation: safeText(s.conversation) } : {}),
    ...(s.projectName !== undefined ? { projectName: safeText(s.projectName) } : {}),
    canOpen: s.phase === 'running' && hostEndpoint(s) !== null,
  };
}

export const listSessionsRun = implement(listSessions, async (asked, input) => {
  // Another user's sandbox: shared, its sessions are listed from their folders; not shared, only whose it is.
  const view = lookAtSandbox(asked);
  const base = {
    sandboxRunning: isSandboxRunning(),
    defaultAgent: asked.loaded.config.defaultHarness,
    wide: input.wide,
    ...(view.line ? { owner: view.line } : {}),
  };
  if (view.limited) return { ...base, sessions: [] };
  const list = await new SessionsService(view.ctx).list();
  return { ...base, sessions: list.map(sessionRow) };
});

export const restartSessionsRun = implement(restartSessions, async (ctx, input, io) => {
  requireOnPc('restart');
  requireRunning();
  await useSharedSandbox(ctx, { kind: 'owner-only', what: 'restart the agents' }, typedConfirm(io));
  const service = new SessionsService(ctx);
  const scope = service.restartScope(input.all);
  if (scope.notAProject)
    io.log(scope.folder + ' is not a project of the running sandbox: restarting every session.', 'muted');
  const what = scope.guest ? 'the agents of ' + scope.projectName : 'every agent';
  const yes = await io.confirm({
    title: 'Restart ' + what + '?',
    lines: ['The agents are started again and continue their conversations where they can.'],
    yes: 'Restart',
    implied: true,
  });
  if (!yes) cancelled();
  io.progress('Restarting the agents' + (scope.guest ? ' of ' + scope.projectName : ''));
  return { message: safeText(await service.restart(input.harness ?? null, scope.guest)) };
});
