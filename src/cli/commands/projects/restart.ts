// The last way in for a folder the running sandbox cannot show (not in a project root, no `wsb share`): restart it
// with that folder mapped as well. Only ever with your consent (a prompt, or --yes): it lists what will end, stops
// the sandbox cleanly (history and claude-mem sync back as on any close), starts it again from the same launch
// folder with the projects it had plus the new one, reopens the sessions it ended (continuing their conversations
// where the agent supports it) and then starts the new project's session.
import path from 'node:path';
import _ from 'lodash';
import type { SessionStatus } from '../../../core/types.js';
import { askYesNo } from '../../../core/prompt.js';
import { fail, safeText, sleep } from '../../../core/util/index.js';
import { currentSessions, execInSandbox } from '../../../host/channel/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { readRegistry, type ProjectRegistry } from '../../../host/projects/index.js';
import { type NeedsRestart } from '../../../host/projects/index.js';
import { hostDirFor, projectForGuestDir } from '../../../shared/paths/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import { watcherRunning } from '../../../sync/index.js';
import { c } from '../../output/index.js';
import { working } from '../../output/index.js';
import { sandboxAlive, type Context } from '../context.js';

/** "2 sessions (claude in api, codex in web)". */
export const describeSessions = (sessions: Pick<SessionStatus, 'harness' | 'cwd' | 'project'>[]): string =>
  sessions.length === 0
    ? 'no sessions'
    : sessions.length +
      ' session' +
      (sessions.length === 1 ? '' : 's') +
      ' (' +
      sessions.map((s) => safeText(s.harness) + ' in ' + safeText(s.project ?? path.win32.basename(s.cwd))).join(', ') +
      ')';

/** The command to run again with consent, for a non-interactive terminal. */
const againWithYes = (ctx: Context): string =>
  'sandbox ' +
  (ctx.options.noAgent ? 'start' : (ctx.options.harness ?? ctx.loaded.config.defaultHarness)) +
  (ctx.options.terminal ? ' -t' : '') +
  ' --yes';

/** Where each running session is on this PC, so it can be reopened after the restart. */
const sessionsToReopen = (
  registry: ProjectRegistry,
  sessions: SessionStatus[],
): { harness: string; hostDir: string }[] =>
  sessions.flatMap((s) => {
    const project = projectForGuestDir([...registry.projects, ...registry.roots.map((r) => ({ ...r }))], s.cwd);
    return project ? [{ harness: s.harness, hostDir: hostDirFor(project, s.cwd) }] : [];
  });

/** Shuts the sandbox down and waits until it (and the background sync's final pass) is gone. */
const stopAndWait = async (ctx: Context): Promise<void> => {
  const status = new RunDir(ctx.dataPath).readSandboxStatus();
  await working('Stopping the sandbox (history syncs back)', async () => {
    await execInSandbox(
      ctx.dataPath,
      ['C:\\Windows\\System32\\shutdown.exe', '/s', '/t', '0'],
      status?.guestWorkspace ?? 'C:\\',
      30,
      sandboxAlive,
    ).catch(() => null);
    for (let i = 0; i < 180 && isSandboxRunning(); i++) await sleep(1000);
    if (isSandboxRunning())
      fail('The sandbox did not shut down within 3 minutes.', 'Close its window yourself, then run the command again.');
    // The watcher syncs history back a few seconds after the window closes; the next start needs it gone.
    for (let i = 0; i < 60 && watcherRunning(ctx.dataPath); i++) await sleep(1000);
  });
};

export const offerRestart = async (
  ctx: Context,
  needs: NeedsRestart[],
  then: () => Promise<number>,
): Promise<number> => {
  const folders = needs.map((n) => n.hostDir);
  const registry =
    readRegistry(ctx.storageRoot) ??
    fail(
      'The running sandbox was started by an older version, so it cannot take another folder.',
      'Stop it (sandbox stop) and start it again from ' + folders[0] + '.',
    );
  const primary =
    registry.projects.find((p) => p.primary) ??
    fail('The running sandbox has no launch folder on record.', 'Stop it (sandbox stop) and start it again.');
  const sessions = currentSessions(ctx.dataPath);
  for (const need of needs)
    console.log(c.yellow('Windows Sandbox cannot add ' + need.hostDir + ' while it runs: ' + need.reason + '.'));
  console.log(
    'A restart maps ' +
      (needs.length === 1 ? 'it' : 'them') +
      ' as well (and keeps ' +
      registry.projects.map((p) => p.host).join(', ') +
      '). ' +
      (sessions.length ? describeSessions(sessions) + ' will end' : 'No session is running') +
      '; your files, tools, databases and logins are kept. It takes about a minute.',
  );
  for (const parent of _.uniq(folders.map((f) => path.dirname(f))))
    console.log(
      c.dim('No restart next time for folders in ' + parent + ': sandbox projects roots add "' + parent + '"'),
    );
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!ctx.options.yes) {
    if (!interactive)
      fail('Not restarting without your consent.', 'Run it again with --yes to restart: ' + againWithYes(ctx));
    if (!(await askYesNo('Restart the sandbox now?'))) {
      console.log('Nothing changed.');
      return 1;
    }
  }
  const reopen = sessionsToReopen(registry, sessions);
  const resume =
    reopen.length > 0 &&
    (ctx.options.yes ||
      (await askYesNo(
        'Reopen the ' +
          reopen.length +
          ' session(s) afterwards (continuing their conversations where the agent supports it)?',
        true,
      )));

  await stopAndWait(ctx);
  // Imported here: launch.ts imports this file.
  const { launch, openSession, readySandbox } = await import('../launch/index.js');
  const { joinHere } = await import('./here.js');
  const keep = registry.projects.filter((p) => !p.primary && p.mechanism !== 'root').map((p) => p.host);
  const relaunch: Context = {
    ...ctx,
    options: {
      ...ctx.options,
      workspace: primary.host,
      harness: ctx.options.harness ?? ctx.options.sessions[0]?.harness,
      terminal: false,
      noAgent: false,
      newSession: true,
      passthrough: [],
      sessions: [],
    },
  };
  await launch(relaunch, false, { extraProjects: [...keep, ...folders], autoSession: false, waitUntilReady: true });
  const ready = await readySandbox(ctx.dataPath);
  if (resume) {
    for (const s of reopen) {
      const at: Context = {
        ...ctx,
        options: {
          ...ctx.options,
          workspace: s.hostDir,
          harness: s.harness,
          terminal: false,
          newSession: true,
          passthrough: [],
          sessions: [],
        },
      };
      try {
        const joined = await joinHere(at, ready);
        await openSession(at, ready, joined, {
          attach: false,
          harness: s.harness,
          args: ctx.loaded.config.harnesses[s.harness]?.resumeArguments ?? [],
          reuse: false,
        });
      } catch (e) {
        console.warn(
          c.yellow(
            'Could not reopen ' + s.harness + ' in ' + s.hostDir + ': ' + (e instanceof Error ? e.message : String(e)),
          ),
        );
      }
    }
  }
  return then();
};
