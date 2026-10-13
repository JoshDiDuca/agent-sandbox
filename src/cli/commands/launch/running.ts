import { attachTerminal, findUnwatchedSession } from '../../../host/channel/index.js';
import { requestSession, waitForReady, waitForSession } from '../../../host/channel/index.js';
import { insideSandbox } from '../../../host/sandbox/index.js';
import { NeedsRestart } from '../../../host/projects/index.js';
import { hideSandboxWindow, showSandboxWindow } from '../../../host/sandbox/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import type { SandboxStatus, SessionStatus } from '../../../core/types.js';
import { errMsg, fail, sleep } from '../../../core/util/index.js';
import { c } from '../../output/index.js';
import { working } from '../../output/index.js';
import { sandboxAlive, type Context } from '../context.js';
import { table } from '../../output/index.js';
import _ from 'lodash';
import { hereDir, joinHere, readyHere, type Joined } from '../projects/index.js';
import { offerRestart } from '../projects/index.js';

/** Attaches this terminal; with attach.autoHide the sandbox window hides meanwhile (best effort, never fails the attach). */
export const attachHere = (ctx: Context, session: Parameters<typeof attachTerminal>[0]): Promise<number> => {
  if (ctx.loaded.config.attach.autoHide && !insideSandbox())
    void hideSandboxWindow(ctx.storageRoot, 120).catch(() => false);
  return attachTerminal(session);
};

/** The sandbox writes sandbox.json a few seconds into its boot; a second launch right after the first waits for it. */
export const runningSandboxStatus = async (dataPath: string): Promise<SandboxStatus> => {
  for (let i = 0; i < 60; i++) {
    const status = new RunDir(dataPath).readSandboxStatus();
    if (status) return status;
    await sleep(1000);
  }
  return fail(
    'A Windows Sandbox is running that this tool did not start (or that uses another storage.dataName).',
    'Close that sandbox window first, then run sandbox claude again.',
  );
};

/** Waits for the boot with its current step on a spinner (plain lines without a terminal). */
export const waitForBoot = (dataPath: string, launchId: string | null): Promise<SandboxStatus> => {
  let step = 'starting Windows Sandbox';
  return working(
    () => 'Waiting for the sandbox: ' + step,
    () =>
      waitForReady(dataPath, launchId, sandboxAlive, (m) => {
        step = m;
      }),
  );
};

/** The running sandbox, once it is ready. */
export const readySandbox = async (dataPath: string): Promise<SandboxStatus> => {
  const status = await runningSandboxStatus(dataPath);
  return status.phase === 'ready' ? status : waitForBoot(dataPath, status.launchId);
};

/** Waits for a session to start (its project's setup, the agent's install) with its progress on a spinner. */
export const waitForStart = (ctx: Context, requestId: string, what: string): Promise<SessionStatus> => {
  let step = 'starting';
  return working(
    () => what + ': ' + step,
    () =>
      waitForSession(ctx.dataPath, requestId, sandboxAlive, 60 * 60 * 1000, (m) => {
        step = m;
      }),
  );
};

/**
 * Starts (or picks back up) a session in the folder `joined` describes. attach: show it in this terminal.
 * Exported for restart.ts, which reopens the sessions a restart ended.
 */
export const openSession = async (
  ctx: Context,
  ready: SandboxStatus,
  joined: Joined,
  o: { attach: boolean; harness?: string; args?: string[]; reuse?: boolean },
): Promise<number> => {
  const { options, loaded, dataPath } = ctx;
  const cwd = joined.guestDir;
  const harness = o.harness ?? options.harness ?? joined.harness ?? loaded.config.defaultHarness;
  const args = o.args ?? options.passthrough;
  // -t with nothing new for the agent: pick up this folder's session if no terminal on this PC shows it (its tab was
  // closed, or you detached). Someone already attached, --new, or agent arguments: a new session, as before.
  const reuse =
    (o.reuse ?? true) && o.attach && !options.newSession && args.length === 0 && loaded.config.attach.reuseSession;
  const existing = reuse ? await findUnwatchedSession(dataPath, harness, cwd) : null;
  if (existing) {
    console.log(
      'Reattaching to ' +
        harness +
        ' session ' +
        existing.id +
        ' in ' +
        cwd +
        ' (no other terminal is attached; --new starts another).',
    );
    return attachHere(ctx, existing);
  }
  console.log(
    joined.spec
      ? 'Starting ' +
          harness +
          ' for ' +
          joined.project?.host +
          ' in the running sandbox (' +
          cwd +
          '; the first time sets up what it needs).'
      : 'Sandbox already running: starting another ' + harness + ' session in ' + cwd,
  );
  // The agent's definition goes along: the sandbox may have booted with another agent.
  const harnessSpec = loaded.config.harnesses[harness];
  const requestId = requestSession(dataPath, harness, args, cwd, {
    ...(joined.spec ? { project: joined.spec } : {}),
    ...(harnessSpec ? { harnessSpec } : {}),
  });
  const session = await waitForStart(ctx, requestId, 'Starting ' + harness + ' in ' + cwd);
  if (o.attach) return attachHere(ctx, session);
  console.log(
    'Session ' +
      session.id +
      ' opened in a new tab inside the sandbox. Attach here with: sandbox attach ' +
      session.id +
      (ready.headless ? '   (headless: sbx-show opens the window)' : ''),
  );
  return 0;
};

/** The sessions a launch asks for: each --session, else one (the agent, in this folder). */
const wantedSessions = (ctx: Context): { harness?: string; folder: string; args?: string[] }[] =>
  ctx.options.sessions.length ? ctx.options.sessions : [{ harness: ctx.options.harness, folder: hereDir(ctx) }];

/** The same command, for one of its sessions (its folder, agent, and the arguments after -- plus its own). */
export const contextFor = (ctx: Context, want: { harness?: string; folder: string; args?: string[] }): Context => ({
  ...ctx,
  options: {
    ...ctx.options,
    workspace: want.folder,
    harness: want.harness,
    sessions: [],
    passthrough: [...ctx.options.passthrough, ...(want.args ?? [])],
  },
});

/** Several sessions at once: all requested together (projects set up in parallel), then listed; -t attaches the first. */
const openSessions = async (
  ctx: Context,
  ready: SandboxStatus,
  list: { ctx: Context; joined: Joined }[],
): Promise<number> => {
  const { dataPath, loaded, options } = ctx;
  const requests = list.map(({ ctx: at, joined }) => {
    const harness = at.options.harness ?? joined.harness ?? loaded.config.defaultHarness;
    const harnessSpec = loaded.config.harnesses[harness];
    const id = requestSession(dataPath, harness, at.options.passthrough, joined.guestDir, {
      ...(joined.spec ? { project: joined.spec } : {}),
      ...(harnessSpec ? { harnessSpec } : {}),
    });
    return { id, harness, folder: at.options.workspace ?? joined.guestDir, cwd: joined.guestDir };
  });
  let started = 0;
  const results = await working(
    () => 'Starting ' + requests.length + ' sessions (' + started + ' running)',
    () =>
      Promise.allSettled(
        requests.map(async (r) => {
          const s = await waitForSession(dataPath, r.id, sandboxAlive, 60 * 60 * 1000, () => undefined);
          started++;
          return s;
        }),
      ),
  );
  table([
    ['SESSION', 'AGENT', 'FOLDER', ''],
    ...requests.map((r, i) => {
      const result = results[i];
      return [
        r.id,
        r.harness,
        r.folder,
        result.status === 'fulfilled' ? 'running   sandbox attach ' + r.id : c.red('FAILED: ' + errMsg(result.reason)),
      ];
    }),
  ]);
  const first = results.find((r): r is PromiseFulfilledResult<SessionStatus> => r.status === 'fulfilled');
  if (options.terminal && first) return attachHere(ctx, first.value);
  if (!first) return 1;
  console.log(
    'Each has its own tab inside the sandbox' +
      (ready.headless ? ' (headless: sbx-show opens the window)' : '') +
      '. Attach to any of them, from any terminal: sandbox attach',
  );
  return results.every((r) => r.status === 'fulfilled') ? 0 : 1;
};

/** A sandbox is already running: open the sessions in it (new tabs inside; optionally attach here). */
export const launchIntoRunning = async (ctx: Context): Promise<number> => {
  const ready = await readySandbox(ctx.dataPath);
  const wants = wantedSessions(ctx);
  // Every folder joins first: when one needs a restart, nothing has been started that the restart would end.
  const joined: { ctx: Context; joined: Joined }[] = [];
  const needs: NeedsRestart[] = [];
  for (const want of wants) {
    const at = ctx.options.sessions.length ? contextFor(ctx, want) : ctx;
    try {
      joined.push({ ctx: at, joined: await joinHere(at, ready) });
    } catch (e) {
      if (!(e instanceof NeedsRestart)) throw e;
      if (!needs.some((n) => n.hostDir.toLowerCase() === e.hostDir.toLowerCase())) needs.push(e);
    }
  }
  if (needs.length) return offerRestart(ctx, needs, () => launchIntoRunning(ctx));
  for (const note of _.uniq(joined.flatMap((j) => j.joined.notes))) console.log(note);
  if (joined.length === 1) return openSession(joined[0].ctx, ready, joined[0].joined, { attach: ctx.options.terminal });
  return openSessions(ctx, ready, joined);
};

/** `sandbox start` while one runs: this folder joins it (set up, no agent), or a restart that adds it is offered. */
export const startIntoRunning = async (ctx: Context): Promise<number> => {
  const ready = await readySandbox(ctx.dataPath);
  let joined: Joined;
  try {
    joined = await readyHere(ctx, ready);
  } catch (e) {
    if (e instanceof NeedsRestart) return offerRestart(ctx, [e], () => startIntoRunning(ctx));
    throw e;
  }
  const where = joined.spec
    ? ' This folder is ready in it as ' +
      joined.guestDir +
      ' (sbx-shell ' +
      joined.spec.name +
      ' opens a terminal there inside).'
    : '';
  console.log(
    'A sandbox is already running' +
      (showSandboxWindow(ctx.storageRoot) ? '; its window is in front now.' : '.') +
      where +
      ' Start an agent in it with sandbox claude (or sandbox <agent>); stop it with sandbox stop.',
  );
  return 0;
};
