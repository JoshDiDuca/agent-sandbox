// Host side of the sandbox channel: follow the boot and send requests (sessions, exec, restart, ping). Attaching a
// terminal to a session is in attach.ts. Everything read from the run folder is guest-written and treated as untrusted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { GuestRequest, GuestResponse, SandboxStatus, SessionStatus } from '../core/types.js';
import { assertNoLinks, fail, isLink, removeLink, safeText, sleep } from '../core/util.js';
import { listSessions, now, readResponse, readSandboxStatus, readSession, runPaths, writeJsonAtomic } from '../shared/rundir.js';
import { safeRemove } from '../shared/safe-remove.js';
import { assertTestWritable, refuseInSelfTest } from './test-guard.js';

const BOOT_TIMEOUT_MS = 30 * 60 * 1000;


const id = (): string => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

const until = async <T>(timeoutMs: number, isAlive: () => boolean, poll: () => T | null | undefined, timeoutMessage: string): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (let round = 0; Date.now() < deadline; round++) {
    const value = poll();
    if (value !== null && value !== undefined) return value;
    if (round % 10 === 0 && !isAlive()) fail('Windows Sandbox closed (or is not running).', 'Start it again with sandbox claude; sandbox logs shows what happened.');
    await sleep(500);
  }
  fail(timeoutMessage, 'Check what the sandbox is doing with sandbox logs -f (or sbx-show to see its window).');
};

/** Waits until the sandbox finished provisioning, printing each boot step. */
export const waitForReady = (dataPath: string, launchId: string | null, isAlive: () => boolean): Promise<SandboxStatus> => {
  let last = '';
  return until(BOOT_TIMEOUT_MS, isAlive, () => {
    const status = readSandboxStatus(dataPath);
    if (!status || (launchId !== null && status.launchId !== launchId)) return null;
    if (status.message !== last) { console.log('  [sandbox] ' + safeText(status.message).slice(0, 300)); last = status.message; }
    if (status.phase === 'failed') fail('The sandbox failed to start: ' + status.message, 'See sandbox logs for details; the sandbox window shows the error too (sbx-show if headless).');
    return status.phase === 'ready' ? status : null;
  }, 'Timed out waiting for the sandbox to finish provisioning.');
};

export const sendRequest = (dataPath: string, request: GuestRequest): void => {
  assertTestWritable(dataPath);
  // Asking the sandbox to power off is the one request with an effect outside it, so the self-test never sends it.
  if (request.kind === 'exec' && /shutdown/i.test(request.command[0] ?? '')) refuseInSelfTest('shut down Windows Sandbox');
  assertNoLinks(dataPath, runPaths(dataPath).requests);
  writeJsonAtomic(runPaths(dataPath).request(request.id), request);
};

export const waitForResponse = (dataPath: string, requestId: string, isAlive: () => boolean, timeoutMs: number): Promise<GuestResponse> =>
  until(timeoutMs, isAlive, () => {
    const response = readResponse(dataPath, requestId);
    if (response) try { assertNoLinks(dataPath, runPaths(dataPath).responses); fs.rmSync(runPaths(dataPath).response(requestId), { force: true }); } catch { /* a planted link: the answer is read, nothing is deleted */ }
    return response;
  }, 'The sandbox did not answer (its session daemon may have stopped).');

export const requestSession = (dataPath: string, harness: string, args: string[], cwd: string): string => {
  const requestId = id();
  sendRequest(dataPath, { kind: 'session', id: requestId, harness, args, cwd, createdAt: now() });
  return requestId;
};

export const waitForSession = (dataPath: string, sessionId: string, isAlive: () => boolean, timeoutMs = 15 * 60 * 1000): Promise<SessionStatus> => {
  let last = '';
  return until(timeoutMs, isAlive, () => {
    const session = readSession(dataPath, sessionId);
    if (!session) return null;
    if (session.message !== last) { console.log('  [session] ' + safeText(session.message).slice(0, 300)); last = session.message; }
    if (session.phase === 'failed') fail('The agent session failed to start: ' + session.message, 'See sandbox logs for details.');
    if (session.phase === 'exited') fail('The agent exited right away (code ' + session.exitCode + ').', 'Check sandbox logs; a wrong agent argument is the usual cause.');
    return session.phase === 'running' ? session : null;
  }, 'Timed out waiting for the session to start.');
};

/** Runs a command inside the sandbox (in the workspace or a folder below it) and returns its output. */
export const execInSandbox = async (dataPath: string, command: string[], cwd: string, timeoutSeconds: number, isAlive: () => boolean): Promise<GuestResponse> => {
  const requestId = id();
  sendRequest(dataPath, { kind: 'exec', id: requestId, command, cwd, timeoutSeconds, createdAt: now() });
  return waitForResponse(dataPath, requestId, isAlive, (timeoutSeconds + 30) * 1000);
};

/** Restarts running sessions in place (they resume via the harness's resumeArguments, e.g. claude --continue). */
export const restartSessions = async (dataPath: string, harness: string | null, isAlive: () => boolean): Promise<GuestResponse> => {
  const requestId = id();
  sendRequest(dataPath, { kind: 'restart', id: requestId, harness, createdAt: now() });
  return waitForResponse(dataPath, requestId, isAlive, 30000);
};

export const pingSandbox = async (dataPath: string, isAlive: () => boolean): Promise<GuestResponse> => {
  const requestId = id();
  sendRequest(dataPath, { kind: 'ping', id: requestId, createdAt: now() });
  return waitForResponse(dataPath, requestId, isAlive, 15000);
};

export const runningSessions = (dataPath: string): SessionStatus[] => listSessions(dataPath).filter((s: SessionStatus) => s.phase === 'running');

/** Most sessions the host will ever contact for one listing: a sandbox can write as many session files as it likes. */
export const MAX_QUERIED_SESSIONS = 32;

/** Running sessions of the sandbox that is running now (its launch id), newest last, capped. */
export const currentSessions = (dataPath: string): SessionStatus[] => {
  const launchId = readSandboxStatus(dataPath)?.launchId;
  return runningSessions(dataPath).filter((s) => s.launchId === launchId).slice(-MAX_QUERIED_SESSIONS);
};

/** The session with this id (or id prefix), else the most recently started running one. */
export const pickSession = (dataPath: string, sessionId?: string): SessionStatus => {
  const running = runningSessions(dataPath);
  if (running.length === 0) fail('No agent session is running in the sandbox.', 'Start one with sandbox claude (it opens a new session in the running sandbox).');
  if (!sessionId) return running[running.length - 1];
  return running.find((s: SessionStatus) => s.id === sessionId || s.id.startsWith(sessionId)) ?? fail('No running session "' + sessionId + '".', 'Running sessions: ' + running.map((s) => s.id).join(', ') + ' (sandbox sessions lists them).');
};


/** Forgets status from a previous sandbox run so nothing stale is picked up. */
export const resetRunDir = (dataPath: string): void => {
  const p = runPaths(dataPath);
  // A link (planted by a sandbox) is removed itself and never followed, including `run` itself.
  if (isLink(p.run)) { removeLink(p.run); return; }
  for (const target of [p.sandbox, p.requests, p.responses, p.sessions]) {
    safeRemove(target, dataPath);
  }
};
