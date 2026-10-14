// The last way in for a folder the running sandbox cannot show (not in a project root, no `wsb share`): restart it
// with that folder mapped as well. Only ever with your consent (a prompt, or --yes): it lists what will end, stops
// the sandbox cleanly (history and claude-mem sync back as on any close), starts it again from the same launch
// folder with the projects it had plus the new one, reopens the sessions it ended (continuing their conversations
// where the agent supports it) and then starts the new project's session.
import path from 'node:path';
import _ from 'lodash';
import type { SessionStatus } from '../../../core/types.js';
import { askYesNo } from '../../../core/prompt.js';
import { missingTip } from '../../../core/local-config/index.js';
import { fail, sleep } from '../../../core/util/index.js';
import { SandboxChannel } from '../../../host/channel/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { ProjectRegistry, type Registry, type NeedsRestart } from '../../../host/projects/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import { SessionLedger } from '../../../host/life/index.js';
import { watcherRunning } from '../../../sync/index.js';
import { c, working } from '../../output/index.js';
import type { Context } from '../context.js';
import { freshContext, reopenedText, reopenSessions, sessionsToReopen, type Relauncher } from '../sessions/reopen.js';
import { markRestarted } from './here.js';
import { describeSessions } from './describe-sessions.js';

export type { Relauncher };

/** The command to run again with consent, for a non-interactive terminal. */
function againWithYes(ctx: Context): string {
  return (
    'sandbox ' +
    (ctx.options.noAgent ? 'start' : (ctx.options.harness ?? ctx.loaded.config.defaultHarness)) +
    (ctx.options.terminal ? ' -t' : '') +
    ' --yes'
  );
}

/** Shuts the sandbox down and waits until it (and the background sync's final pass) is gone. */
async function stopAndWait(ctx: Context): Promise<void> {
  const status = new RunDir(ctx.dataPath).readSandboxStatus();
  // Stopped on purpose, not a crash: the watcher must not start it again by itself.
  new SessionLedger(ctx.storageRoot, ctx.dataPath).markClosedOnPurpose();
  await working('Stopping the sandbox (history syncs back)', async () => {
    await new SandboxChannel(ctx.dataPath)
      .exec(['C:\\Windows\\System32\\shutdown.exe', '/s', '/t', '0'], status?.guestWorkspace ?? 'C:\\', 30)
      .catch(() => null);
    for (let i = 0; i < 180 && isSandboxRunning(); i++) await sleep(1000);
    if (isSandboxRunning())
      fail('The sandbox did not shut down within 3 minutes.', 'Close its window yourself, then run the command again.');
    // The watcher syncs history back a few seconds after the window closes; the next start needs it gone.
    for (let i = 0; i < 60 && watcherRunning(ctx.dataPath); i++) await sleep(1000);
  });
}

/**
 * Says what a restart maps, keeps and ends. `hidden`: the folders the running sandbox cannot show; a project that only
 * wants boot settings or folders is not among them (you already chose the restart, or gave --yes, when asked).
 */
function explain(needs: NeedsRestart[], hidden: NeedsRestart[], registry: Registry, sessions: SessionStatus[]): void {
  for (const need of hidden)
    console.log(c.yellow('Windows Sandbox cannot add ' + need.hostDir + ' while it runs: ' + need.reason + '.'));
  console.log(
    (hidden.length
      ? 'A restart maps ' + (hidden.length === 1 ? 'it' : 'them') + ' as well'
      : 'Restarting with what ' + needs.map((n) => path.basename(n.hostDir)).join(', ') + ' wants') +
      ' (and keeps ' +
      registry.projects.map((p) => p.host).join(', ') +
      '). ' +
      (sessions.length ? describeSessions(sessions) + ' will end and reopen afterwards' : 'No session is running') +
      '; your files, tools, databases and logins are kept. It takes about a minute.',
  );
  for (const parent of _.uniq(hidden.map((n) => path.dirname(n.hostDir))))
    console.log(
      c.dim('No restart next time for folders in ' + parent + ': sandbox projects roots add "' + parent + '"'),
    );
  for (const need of needs) if (need.missing) console.log(c.dim(missingTip(need.missing)));
}

/** --yes, or a yes at the prompt; without a terminal to ask in, it fails with the command to run. */
async function consented(ctx: Context): Promise<boolean> {
  if (ctx.options.yes) return true;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive)
    fail('Not restarting without your consent.', 'Run it again with --yes to restart: ' + againWithYes(ctx));
  return askYesNo('Restart the sandbox now? (its sessions reopen and continue)');
}

export async function offerRestart(
  ctx: Context,
  needs: NeedsRestart[],
  then: () => Promise<number>,
  relauncher: Relauncher,
): Promise<number> {
  const folders = needs.map((n) => n.hostDir);
  const registry =
    new ProjectRegistry(ctx.storageRoot).read() ??
    fail(
      'The running sandbox was started by an older version, so it cannot take another folder.',
      'Stop it (sandbox stop) and start it again from ' + folders[0] + '.',
    );
  const primary =
    registry.projects.find((p) => p.primary) ??
    fail('The running sandbox has no launch folder on record.', 'Stop it (sandbox stop) and start it again.');
  const sessions = new SandboxChannel(ctx.dataPath).currentSessions();
  const hidden = needs.filter((n) => !n.missing);
  explain(needs, hidden, registry, sessions);
  if (hidden.length && !(await consented(ctx))) {
    console.log('Nothing changed.');
    return 1;
  }
  const reopen = sessionsToReopen(registry, sessions);

  await stopAndWait(ctx);
  markRestarted();
  const keep = registry.projects.filter((p) => !p.primary && p.mechanism !== 'root').map((p) => p.host);
  const harness = ctx.options.harness ?? ctx.options.sessions[0]?.harness;
  const relaunch = freshContext(ctx, primary.host, harness, { noAgent: false });
  await relauncher.launch(relaunch, false, {
    extraProjects: [...keep, ...folders],
    autoSession: false,
    waitUntilReady: true,
  });
  const ready = await relauncher.readySandbox(ctx.dataPath);
  if (reopen.length) {
    const opened = await reopenSessions(ctx, ready, reopen, relauncher);
    console.log(reopenedText(opened, reopen.length, reopen));
  }
  return then();
}
