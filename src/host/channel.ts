// Host side of the sandbox channel: follow the boot, send requests (sessions, exec, restart), and bridge this terminal
// to a session's pseudo console. Everything read from the run folder is guest-written and treated as untrusted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import type { GuestRequest, GuestResponse, SandboxStatus, SessionStatus } from '../core/types.js';
import { connect, DETACH_KEY, queryViewers, runTerminalClient, type Endpoint, type Viewers } from '../shared/pty-client.js';
import { listSessions, now, readResponse, readSandboxStatus, readSession, runPaths, writeJsonAtomic } from '../shared/rundir.js';
import { assertNoLinks, fail, isLink, removeLink, safeText, sleep } from '../core/util.js';

const BOOT_TIMEOUT_MS = 30 * 60 * 1000;

const ipToInt = (ip: string): number => ip.split('.').reduce((n: number, part: string) => n * 256 + Number(part), 0);

/**
 * True only for IPv4 addresses inside the subnet of one of this PC's Hyper-V adapters ("vEthernet ..."), which is
 * where Windows Sandbox lives. Stops a compromised sandbox from pointing the host (and your keystrokes) anywhere else.
 */
export const isSandboxAddress = (ip: string, interfaces = os.networkInterfaces()): boolean => {
  if (!net.isIPv4(ip)) return false;
  return Object.entries(interfaces).some(([name, list]) => /^vEthernet/i.test(name) && (list ?? []).some((i) => {
    if (i.family !== 'IPv4' || i.internal) return false;
    const mask = ipToInt(i.netmask);
    return mask !== 0 && (ipToInt(i.address) & mask) === (ipToInt(ip) & mask) && i.address !== ip;
  }));
};

const id = (): string => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

const until = async <T>(timeoutMs: number, isAlive: () => boolean, poll: () => T | null | undefined, timeoutMessage: string): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = poll();
    if (value !== null && value !== undefined) return value;
    if (!isAlive()) fail('Windows Sandbox closed (or is not running).', 'Start it again with claude-sbx; agent-sandbox logs shows what happened.');
    await sleep(500);
  }
  fail(timeoutMessage, 'Check what the sandbox is doing with agent-sandbox logs -f (or sbx-show to see its window).');
};

/** Waits until the sandbox finished provisioning, printing each boot step. */
export const waitForReady = (dataPath: string, launchId: string | null, isAlive: () => boolean): Promise<SandboxStatus> => {
  let last = '';
  return until(BOOT_TIMEOUT_MS, isAlive, () => {
    const status = readSandboxStatus(dataPath);
    if (!status || (launchId !== null && status.launchId !== launchId)) return null;
    if (status.message !== last) { console.log('  [sandbox] ' + safeText(status.message).slice(0, 300)); last = status.message; }
    if (status.phase === 'failed') fail('The sandbox failed to start: ' + status.message, 'See agent-sandbox logs for details; the sandbox window shows the error too (sbx-show if headless).');
    return status.phase === 'ready' ? status : null;
  }, 'Timed out waiting for the sandbox to finish provisioning.');
};

export const sendRequest = (dataPath: string, request: GuestRequest): void => {
  assertNoLinks(dataPath, runPaths(dataPath).requests);
  writeJsonAtomic(runPaths(dataPath).request(request.id), request);
};

export const waitForResponse = (dataPath: string, requestId: string, isAlive: () => boolean, timeoutMs: number): Promise<GuestResponse> =>
  until(timeoutMs, isAlive, () => {
    const response = readResponse(dataPath, requestId);
    if (response && !isLink(runPaths(dataPath).responses)) fs.rmSync(runPaths(dataPath).response(requestId), { force: true });
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
    if (session.phase === 'failed') fail('The agent session failed to start: ' + session.message, 'See agent-sandbox logs for details.');
    if (session.phase === 'exited') fail('The agent exited right away (code ' + session.exitCode + ').', 'Check agent-sandbox logs; a wrong agent argument is the usual cause.');
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

/** The session with this id (or id prefix), else the most recently started running one. */
export const pickSession = (dataPath: string, sessionId?: string): SessionStatus => {
  const running = runningSessions(dataPath);
  if (running.length === 0) fail('No agent session is running in the sandbox.', 'Start one with claude-sbx (it opens a new session in the running sandbox).');
  if (!sessionId) return running[running.length - 1];
  return running.find((s: SessionStatus) => s.id === sessionId || s.id.startsWith(sessionId)) ?? fail('No running session "' + sessionId + '".', 'Running sessions: ' + running.map((s) => s.id).join(', ') + ' (agent-sandbox sessions lists them).');
};

/** Where this PC may connect for a session: only addresses on its own Hyper-V network (null if there are none). */
const hostEndpoint = (session: SessionStatus): Endpoint | null => {
  const addresses = session.attach?.addresses.filter((a: string) => isSandboxAddress(a)) ?? [];
  return session.attach && addresses.length ? { ...session.attach, addresses } : null;
};

/** Who is watching a session right now (closed terminals do not count); null when it cannot be asked. */
export const sessionViewers = (session: SessionStatus): Promise<Viewers | null> => {
  const endpoint = hostEndpoint(session);
  return endpoint ? queryViewers(endpoint) : Promise.resolve(null);
};

/**
 * The newest running session of this agent in exactly this folder that no terminal on this PC is attached to, so
 * claude-sbx -t picks it back up instead of starting another. A session that cannot answer is never reused.
 */
export const findUnwatchedSession = async (dataPath: string, harness: string, cwd: string): Promise<SessionStatus | null> => {
  const candidates = runningSessions(dataPath).filter((s) => s.harness === harness && s.cwd.toLowerCase() === cwd.toLowerCase()).reverse();
  for (const session of candidates) if ((await sessionViewers(session))?.remote === 0) return session;
  return null;
};

/** Bridges this terminal to a session. Returns the agent's exit code, or 0 when the user detaches. */
export const attachTerminal = async (session: SessionStatus): Promise<number> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('--terminal / attach needs an interactive terminal.', 'Run it directly in Windows Terminal or PowerShell, not through a pipe or script.');
  if (!session.attach) fail('This session cannot be attached to: networking or attach is disabled for this sandbox.', 'Set sandbox.networking and attach.enabled to true, then start a new sandbox.');
  const endpoint = hostEndpoint(session) ?? fail('Refusing to connect: the sandbox reported no address on this PC\'s Hyper-V (vEthernet) network (' + session.attach.addresses.join(', ') + ').', 'Use the sandbox window instead (sbx-show); if this keeps happening, run agent-sandbox doctor.');
  const socket = await connect(endpoint);
  console.log('Attaching to ' + session.harness + ' session ' + session.id + ' (' + session.cwd + '). Detach any time with Ctrl+]');
  await sleep(400);
  const result = await runTerminalClient(socket, session.attach.token, { detachKey: DETACH_KEY });
  switch (result.reason) {
    case 'detach': console.log('Detached. The session keeps running; reattach with: agent-sandbox attach ' + session.id); return 0;
    case 'exit': console.log(session.harness + ' exited with code ' + result.exitCode + '.'); return result.exitCode;
    case 'error': fail('The sandbox refused the connection: ' + result.message, 'Try agent-sandbox attach again; the session may have restarted.');
    default: console.log('Connection to the sandbox closed.'); return 1;
  }
};

/** Forgets status from a previous sandbox run so nothing stale is picked up. */
export const resetRunDir = (dataPath: string): void => {
  const p = runPaths(dataPath);
  // A link (planted by a sandbox) is removed itself and never followed, including `run` itself.
  if (isLink(p.run)) { removeLink(p.run); return; }
  for (const target of [p.sandbox, p.requests, p.responses, p.sessions]) {
    if (isLink(target)) removeLink(target); else fs.rmSync(target, { recursive: true, force: true });
  }
};
