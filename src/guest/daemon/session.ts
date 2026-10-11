// `session` and `restart` requests: agent sessions, each in its own ptyhost process.
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { GuestRequest, SessionStatus } from '../../core/types.js';
import { FrameType, sendControl } from '../../shared/pty-client.js';
import { now } from '../../shared/rundir.js';
import { SYSTEM } from '../../shared/system.js';
import { commandLine, ensurePtyHost, freePort, ptyHostLogTail, startPtyHost, waitForPtyHost } from '../ptyhost.js';
import { provisionHarness, resolveLaunch } from '../setup/agents.js';
import { saveClaudeMem } from '../setup/claude.js';
import { runHooks } from '../setup/hooks.js';
import { guestAddresses } from '../setup/network.js';
import { dataDir, errMsg, exists, log, session, toolsDir, warn, workspace } from '../env.js';
import { maybeShutdown } from './shutdown.js';
import { insideWorkspace, live, pending, respond, safely, saveStatus } from './state.js';

type SessionRequest = Extract<GuestRequest, { kind: 'session' }>;

const terminalTab = (id: string, title: string, cwd: string): void => {
  const view = [process.execPath, path.join(path.dirname(process.argv[1]), 'view.js'), id];
  const wt = path.join(toolsDir, 'terminal', 'wt.exe');
  if (exists(wt)) spawn(wt, ['-w', '0', 'nt', '--title', title, '-d', cwd, ...view], { detached: true, stdio: 'ignore' }).unref();
  else spawn(SYSTEM.cmd(), ['/d', '/c', 'start', title, ...view], { detached: true, stdio: 'ignore', cwd }).unref();
};

const onExit = (running: SessionStatus) => (code: number | null): void => {
  live.delete(running.id);
  const tail = code === 0 ? '' : ptyHostLogTail(running.id, 6);
  saveStatus({ ...running, phase: 'exited', message: running.harness + ' exited with code ' + code + (tail ? '. Last output:\n' + tail : ''), exitCode: code ?? 1, attach: undefined });
  log('Session ' + running.id + ' ended (exit ' + code + ')');
  safely('post-agent hooks', () => runHooks('post-agent', process.env));
  safely('claude-mem save', saveClaudeMem);
  maybeShutdown();
};

/** Starts ptyhost for the agent and waits until it listens; a failure carries the tail of ptyhost's own log. */
const launchPtyHost = async (req: SessionRequest, remote: boolean): Promise<{ child: ChildProcess; port: number; token: string }> => {
  const harness = req.harness === session.harnessName && session.harness ? session.harness : null;
  if (!harness) throw new Error('Agent "' + req.harness + '" is not configured for this sandbox (it runs ' + session.harnessName + ').');
  // Never refresh here: main already did, and replacing a running agent's executable would fail.
  provisionHarness(req.harness, harness, process.env, false);
  const launch = resolveLaunch(req.harness, harness);
  const base = [...launch.args, ...harness.arguments];
  const port = await freePort();
  const token = crypto.randomBytes(24).toString('base64url');
  const child = startPtyHost({
    exe: ensurePtyHost(), port, token, cols: 120, rows: 32, id: req.id, cwd: req.cwd, env: { ...process.env, ...harness.environment }, remote,
    command: commandLine(launch.file, [...base, ...req.args]), restartCommand: commandLine(launch.file, [...base, ...(harness.resumeArguments ?? [])]),
  });
  try { await waitForPtyHost(child, port, 15000); } catch (e) {
    const tail = ptyHostLogTail(req.id);
    throw new Error(errMsg(e) + (tail ? '. From its log:\n' + tail : '') + '\nLog: ' + path.join(dataDir, 'logs', 'ptyhost-' + req.id + '.log'));
  }
  return { child, port, token };
};

export const startSession = async (req: SessionRequest): Promise<void> => {
  const status: SessionStatus = { id: req.id, launchId: session.launchId, harness: req.harness, cwd: req.cwd, phase: 'starting', message: 'Starting ' + req.harness, updatedAt: now(), startedAt: now() };
  saveStatus(status);
  pending.starting++;
  try {
    if (!insideWorkspace(req.cwd) || !exists(req.cwd)) throw new Error('Folder is not inside the sandbox workspace ' + workspace + ': ' + req.cwd);
    const remote = session.networking && session.attach.enabled;
    const { child, port, token } = await launchPtyHost(req, remote);
    const running: SessionStatus = { ...status, phase: 'running', message: req.harness + ' is running', attach: { addresses: remote ? guestAddresses() : [], port, token } };
    live.set(req.id, { status: running, child });
    child.once('exit', onExit(running));
    saveStatus(running);
    log('Session ' + req.id + ' started (' + req.harness + ' in ' + req.cwd + ', port ' + port + ')');
    if (req.id !== session.launchId && process.env.AGENT_NO_TABS !== '1') terminalTab(req.id, req.harness + ' ' + path.basename(req.cwd), req.cwd);
  } catch (e) {
    saveStatus({ ...status, phase: 'failed', message: errMsg(e) });
    warn('Session ' + req.id + ' failed: ' + errMsg(e));
    maybeShutdown();
  } finally {
    pending.starting--;
  }
};

export const restartSessions = async (req: Extract<GuestRequest, { kind: 'restart' }>): Promise<void> => {
  const targets = [...live.values()].filter((s) => s.status.attach && (req.harness === null || s.status.harness === req.harness));
  for (const s of targets) await sendControl({ addresses: ['127.0.0.1'], port: s.status.attach!.port, token: s.status.attach!.token }, FrameType.Restart);
  respond(req.id, { ok: true, message: 'restarted ' + targets.length + ' session(s)' });
};
