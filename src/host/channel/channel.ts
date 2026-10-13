// Host side of the sandbox channel: follow the boot and send requests (sessions, exec, restart, ping). Attaching a
// terminal to a session is in attach.ts. Everything read from the run folder is guest-written and treated as untrusted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { GuestRequest, GuestResponse, Harness, SandboxStatus, SessionStatus } from '../../core/types.js';
import { assertNoLinks, fail, isLink, removeLink, safeText, sleep } from '../../core/util/index.js';
import { isWithin } from '../../shared/paths/index.js';
import type { ProjectSpecT } from '../../shared/channel/index.js';
import { now, RunDir } from '../../shared/channel/index.js';
import { writeJsonAtomic } from '../../shared/io/index.js';
import { safeRemove } from '../../shared/io/index.js';
import { assertTestWritable, refuseInSelfTest } from '../test-guard.js';

const BOOT_TIMEOUT_MS = 30 * 60 * 1000;

const id = (): string => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

const until = async <T>(
  timeoutMs: number,
  isAlive: () => boolean,
  poll: () => T | null | undefined,
  timeoutMessage: string,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (let round = 0; Date.now() < deadline; round++) {
    const value = poll();
    if (value !== null && value !== undefined) return value;
    if (round % 10 === 0 && !isAlive())
      fail(
        'Windows Sandbox closed (or is not running).',
        'Start it again with sandbox claude; sandbox logs shows what happened.',
      );
    await sleep(500);
  }
  fail(timeoutMessage, 'Check what the sandbox is doing with sandbox logs -f (or sbx-show to see its window).');
};

/** Where progress lines go: printed by default; a spinner passes its own. Text from the sandbox, made safe first. */
export type Progress = (line: string) => void;
const printLine: Progress = (line) => console.log(line);

/** Waits until the sandbox finished provisioning, reporting each boot step. */
export const waitForReady = (
  dataPath: string,
  launchId: string | null,
  isAlive: () => boolean,
  progress: Progress = (m) => printLine('  [sandbox] ' + m),
): Promise<SandboxStatus> => {
  let last = '';
  return until(
    BOOT_TIMEOUT_MS,
    isAlive,
    () => {
      const status = new RunDir(dataPath).readSandboxStatus();
      if (!status || (launchId !== null && status.launchId !== launchId)) return null;
      if (status.message !== last) {
        progress(safeText(status.message).slice(0, 300));
        last = status.message;
      }
      if (status.phase === 'failed')
        fail(
          'The sandbox failed to start: ' + status.message,
          'See sandbox logs for details; the sandbox window shows the error too (sbx-show if headless).',
        );
      return status.phase === 'ready' ? status : null;
    },
    'Timed out waiting for the sandbox to finish provisioning.',
  );
};

export const sendRequest = (dataPath: string, request: GuestRequest): void => {
  assertTestWritable(dataPath);
  // Asking the sandbox to power off is the one request with an effect outside it, so the self-test never sends it.
  if (request.kind === 'exec' && /shutdown/i.test(request.command[0] ?? ''))
    refuseInSelfTest('shut down Windows Sandbox');
  assertNoLinks(dataPath, new RunDir(dataPath).requestsDir);
  writeJsonAtomic(new RunDir(dataPath).requestFile(request.id), request);
};

export const waitForResponse = (
  dataPath: string,
  requestId: string,
  isAlive: () => boolean,
  timeoutMs: number,
): Promise<GuestResponse> =>
  until(
    timeoutMs,
    isAlive,
    () => {
      const response = new RunDir(dataPath).readResponse(requestId);
      if (response)
        try {
          assertNoLinks(dataPath, new RunDir(dataPath).responsesDir);
          fs.rmSync(new RunDir(dataPath).responseFile(requestId), { force: true });
        } catch {
          /* a planted link: the answer is read, nothing is deleted */
        }
      return response;
    },
    'The sandbox did not answer (its session daemon may have stopped).',
  );

/** project: a project registered after boot (provisioned first). harnessSpec: the agent's definition, for an agent the sandbox did not boot with. */
export const requestSession = (
  dataPath: string,
  harness: string,
  args: string[],
  cwd: string,
  extra: { project?: ProjectSpecT; harnessSpec?: Harness } = {},
): string => {
  const requestId = id();
  sendRequest(dataPath, {
    kind: 'session',
    id: requestId,
    harness,
    args,
    cwd,
    ...(extra.project ? { project: extra.project } : {}),
    ...(extra.harnessSpec ? { harnessSpec: extra.harnessSpec } : {}),
    createdAt: now(),
  });
  return requestId;
};

/**
 * Provisions a registered project without starting an agent and waits for it, printing its progress (the guest's
 * run\projects\<name>.json) as it goes. Throws when it failed.
 */
export const prepareProject = async (
  dataPath: string,
  project: ProjectSpecT,
  isAlive: () => boolean,
  progress: Progress = (m) => printLine('  [' + project.name + '] ' + m),
): Promise<GuestResponse> => {
  const requestId = id();
  sendRequest(dataPath, { kind: 'project', id: requestId, project, createdAt: now() });
  let last = '';
  const response = await until(
    60 * 60 * 1000,
    isAlive,
    () => {
      const status = new RunDir(dataPath).readProjectStatus(project.name);
      if (status && status.message !== last) {
        progress(safeText(status.message).slice(0, 300));
        last = status.message;
      }
      return new RunDir(dataPath).readResponse(requestId);
    },
    'Timed out waiting for the project to be set up.',
  );
  try {
    assertNoLinks(dataPath, new RunDir(dataPath).responsesDir);
    fs.rmSync(new RunDir(dataPath).responseFile(requestId), { force: true });
  } catch {
    /* read, nothing deleted */
  }
  if (!response.ok) fail(safeText(response.message), 'See sandbox logs for details.');
  return response;
};

export const waitForSession = (
  dataPath: string,
  sessionId: string,
  isAlive: () => boolean,
  timeoutMs = 15 * 60 * 1000,
  progress: Progress = (m) => printLine('  [session] ' + m),
): Promise<SessionStatus> => {
  let last = '';
  return until(
    timeoutMs,
    isAlive,
    () => {
      const session = new RunDir(dataPath).readSession(sessionId);
      if (!session) return null;
      if (session.message !== last) {
        progress(safeText(session.message).slice(0, 300));
        last = session.message;
      }
      if (session.phase === 'failed')
        fail('The agent session failed to start: ' + session.message, 'See sandbox logs for details.');
      if (session.phase === 'exited')
        fail(
          'The agent exited right away (code ' + session.exitCode + ').',
          'Check sandbox logs; a wrong agent argument is the usual cause.',
        );
      return session.phase === 'running' ? session : null;
    },
    'Timed out waiting for the session to start.',
  );
};

/** Runs a command inside the sandbox (in the workspace or a folder below it) and returns its output. */
export const execInSandbox = async (
  dataPath: string,
  command: string[],
  cwd: string,
  timeoutSeconds: number,
  isAlive: () => boolean,
): Promise<GuestResponse> => {
  const requestId = id();
  sendRequest(dataPath, { kind: 'exec', id: requestId, command, cwd, timeoutSeconds, createdAt: now() });
  return waitForResponse(dataPath, requestId, isAlive, (timeoutSeconds + 30) * 1000);
};

/** Restarts running sessions in place (they resume via the harness's resumeArguments, e.g. claude --continue). */
export const restartSessions = async (
  dataPath: string,
  harness: string | null,
  isAlive: () => boolean,
  cwd?: string,
): Promise<GuestResponse> => {
  const requestId = id();
  sendRequest(dataPath, { kind: 'restart', id: requestId, harness, ...(cwd ? { cwd } : {}), createdAt: now() });
  return waitForResponse(dataPath, requestId, isAlive, 30000);
};

export const pingSandbox = async (dataPath: string, isAlive: () => boolean): Promise<GuestResponse> => {
  const requestId = id();
  sendRequest(dataPath, { kind: 'ping', id: requestId, createdAt: now() });
  return waitForResponse(dataPath, requestId, isAlive, 15000);
};

export const runningSessions = (dataPath: string): SessionStatus[] =>
  new RunDir(dataPath).listSessions().filter((s: SessionStatus) => s.phase === 'running');

/** Most sessions the host will ever contact for one listing: a sandbox can write as many session files as it likes. */
export const MAX_QUERIED_SESSIONS = 32;

/** Running sessions of the sandbox that is running now (its launch id), newest last, capped. */
export const currentSessions = (dataPath: string): SessionStatus[] => {
  const launchId = new RunDir(dataPath).readSandboxStatus()?.launchId;
  return runningSessions(dataPath)
    .filter((s) => s.launchId === launchId)
    .slice(-MAX_QUERIED_SESSIONS);
};

/** Sessions in this guest folder or below (one project's) first, each group newest first. */
export const sessionsFirstIn = (sessions: SessionStatus[], guestDir: string | null): SessionStatus[] => {
  const newest = [...sessions].reverse();
  if (!guestDir) return newest;
  return [...newest.filter((s) => isWithin(guestDir, s.cwd)), ...newest.filter((s) => !isWithin(guestDir, s.cwd))];
};

/**
 * The session with this id (or id prefix), else the most recently started running one: in `guestDir` (the project
 * you are in) when it has one, else any.
 */
export const pickSession = (dataPath: string, sessionId?: string, guestDir: string | null = null): SessionStatus => {
  const running = runningSessions(dataPath);
  if (running.length === 0)
    fail(
      'No agent session is running in the sandbox.',
      'Start one with sandbox claude (it opens a new session in the running sandbox).',
    );
  if (!sessionId) return sessionsFirstIn(running, guestDir)[0];
  return (
    running.find((s: SessionStatus) => s.id === sessionId || s.id.startsWith(sessionId)) ??
    fail(
      'No running session "' + sessionId + '".',
      'Running sessions: ' + running.map((s) => s.id).join(', ') + ' (sandbox sessions lists them).',
    )
  );
};

/** Forgets status from a previous sandbox run so nothing stale is picked up. */
export const resetRunDir = (dataPath: string): void => {
  const p = new RunDir(dataPath);
  // A link (planted by a sandbox) is removed itself and never followed, including `run` itself.
  if (isLink(p.root)) {
    removeLink(p.root);
    return;
  }
  for (const target of [p.sandboxFile, p.requestsDir, p.responsesDir, p.sessionsDir, p.projectsDir]) {
    safeRemove(target, dataPath);
  }
};
