// `session` and `restart` requests: agent sessions, each in its own ptyhost process. A session runs in the launch
// folder's project (the boot environment) or in a project registered later, which is provisioned first (daemon/project).
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { GuestRequest, Harness, SessionStatus } from '../../core/types.js';
import { FrameType, sendControl } from '../../shared/pty-client.js';
import { isWithin } from '../../shared/projects.js';
import { now } from '../../shared/rundir.js';
import { SYSTEM } from '../../shared/system.js';
import { commandLine } from '../cmdline.js';
import { freePort } from '../ports.js';
import { primaryProject } from '../project-status.js';
import { ensurePtyHost, ptyHostLogTail, startPtyHost, waitForPtyHost } from '../ptyhost.js';
import { provisionHarness, resolveLaunch } from '../setup/agents.js';
import { saveClaudeMem } from '../setup/claude.js';
import { projectHooks, runHooks, runHooksAsync, type HookTarget } from '../setup/hooks.js';
import { guestAddresses } from '../setup/network.js';
import { dataDir, errMsg, exists, log, session, toolsDir, warn, workspace } from '../env.js';
import { provisionProject } from './project.js';
import { maybeShutdown } from './shutdown.js';
import { insidePrimary, live, pending, respond, safely, saveStatus } from './state.js';

type SessionRequest = Extract<GuestRequest, { kind: 'session' }>;

const terminalTab = (id: string, title: string, cwd: string): void => {
  const view = [process.execPath, path.join(path.dirname(process.argv[1]), 'view.js'), id];
  const wt = path.join(toolsDir, 'terminal', 'wt.exe');
  if (exists(wt)) spawn(wt, ['-w', '0', 'nt', '--title', title, '-d', cwd, ...view], { detached: true, stdio: 'ignore' }).unref();
  else spawn(SYSTEM.cmd(), ['/d', '/c', 'start', title, ...view], { detached: true, stdio: 'ignore', cwd }).unref();
};

/** Where a session runs: its environment and hooks (the boot's, or its project's). */
interface Place { env: NodeJS.ProcessEnv; hooks: HookTarget | null; project: string }

const onExit = (running: SessionStatus, place: Place) => (code: number | null): void => {
  live.delete(running.id);
  const tail = code === 0 ? '' : ptyHostLogTail(running.id, 6);
  saveStatus({ ...running, phase: 'exited', message: running.harness + ' exited with code ' + code + (tail ? '. Last output:\n' + tail : ''), exitCode: code ?? 1, attach: undefined });
  log('Session ' + running.id + ' ended (exit ' + code + ')');
  if (place.hooks) void runHooksAsync('post-agent', place.env, place.hooks).catch((e: unknown) => warn('post-agent hooks failed: ' + errMsg(e)));
  else safely('post-agent hooks', () => runHooks('post-agent', process.env));
  safely('claude-mem save', saveClaudeMem);
  maybeShutdown();
};

/**
 * The agent's definition: the one the sandbox booted with, the one the host sent along (another agent, e.g.
 * sandbox codex in a sandbox started for claude), or one the project's config names.
 */
const harnessFor = (req: SessionRequest): Harness => {
  if (req.harness === session.harnessName && session.harness) return session.harness;
  const sent = req.harnessSpec ?? req.project?.harnesses[req.harness];
  if (sent) return sent;
  throw new Error('Agent "' + req.harness + '" is not configured for this sandbox (it runs ' + session.harnessName + ').');
};

/** Starts ptyhost for the agent and waits until it listens; a failure carries the tail of ptyhost's own log. */
const launchPtyHost = async (req: SessionRequest, remote: boolean, env: NodeJS.ProcessEnv, say: (m: string) => void): Promise<{ child: ChildProcess; port: number; token: string }> => {
  const harness = harnessFor(req);
  // Never refresh here: main already did, and replacing a running agent's executable would fail.
  say('Preparing ' + req.harness);
  await provisionHarness(req.harness, harness, env, false);
  const launch = resolveLaunch(req.harness, harness);
  const base = [...launch.args, ...harness.arguments];
  const port = await freePort();
  const token = crypto.randomBytes(24).toString('base64url');
  const child = startPtyHost({
    exe: ensurePtyHost(), port, token, cols: 120, rows: 32, id: req.id, cwd: req.cwd, env: { ...env, ...harness.environment }, remote,
    command: commandLine(launch.file, [...base, ...req.args]), restartCommand: commandLine(launch.file, [...base, ...(harness.resumeArguments ?? [])]),
  });
  try { await waitForPtyHost(child, port, 15000); } catch (e) {
    const tail = ptyHostLogTail(req.id);
    throw new Error(errMsg(e) + (tail ? '. From its log:\n' + tail : '') + '\nLog: ' + path.join(dataDir, 'logs', 'ptyhost-' + req.id + '.log'));
  }
  return { child, port, token };
};

/** The launch folder's project, or the registered project this session is for (provisioned first if needed). */
const placeFor = async (req: SessionRequest, say: (m: string) => void): Promise<Place> => {
  if (!req.project) {
    if (!insidePrimary(req.cwd) || !exists(req.cwd)) throw new Error('Folder is not inside the sandbox workspace ' + workspace + ': ' + req.cwd);
    return { env: process.env, hooks: null, project: primaryProject() };
  }
  if (!isWithin(req.project.workspace, req.cwd)) throw new Error('Folder ' + req.cwd + ' is not inside project ' + req.project.name + ' (' + req.project.workspace + ').');
  const ready = await provisionProject(req.project, say);
  if (!exists(req.cwd)) throw new Error('Folder does not exist in the sandbox: ' + req.cwd);
  return { env: ready.env, hooks: req.project.hooks ? projectHooks(req.project.name, req.project.workspace) : null, project: req.project.name };
};

export const startSession = async (req: SessionRequest): Promise<void> => {
  let status: SessionStatus = { id: req.id, launchId: session.launchId, harness: req.harness, cwd: req.cwd, ...(req.project ? { project: req.project.name } : {}), phase: 'starting', message: 'Starting ' + req.harness, updatedAt: now(), startedAt: now() };
  saveStatus(status);
  // Progress goes into the session's status: the host prints it while it waits, and the tab inside shows it.
  const say = (message: string): void => { status = { ...status, message }; saveStatus(status); };
  pending.starting++;
  // Sessions after the first get their own tab right away (it shows the setup progress until the agent starts).
  if (req.id !== session.launchId && process.env.AGENT_NO_TABS !== '1') safely('terminal tab', () => terminalTab(req.id, req.harness + ' ' + path.basename(req.cwd), req.cwd));
  try {
    const place = await placeFor(req, say);
    const remote = session.networking && session.attach.enabled;
    const { child, port, token } = await launchPtyHost(req, remote, place.env, say);
    const running: SessionStatus = { ...status, project: place.project, phase: 'running', message: req.harness + ' is running', attach: { addresses: remote ? guestAddresses() : [], port, token } };
    live.set(req.id, { status: running, child });
    child.once('exit', onExit(running, place));
    saveStatus(running);
    log('Session ' + req.id + ' started (' + req.harness + ' in ' + req.cwd + ', project ' + place.project + ', port ' + port + ')');
  } catch (e) {
    saveStatus({ ...status, phase: 'failed', message: errMsg(e) });
    warn('Session ' + req.id + ' failed: ' + errMsg(e));
    maybeShutdown();
  } finally {
    pending.starting--;
  }
};

/** `project` requests: provision a registered project without an agent (sandbox start / exec / db from its folder). */
export const prepareProject = async (req: Extract<GuestRequest, { kind: 'project' }>): Promise<void> => {
  pending.starting++;
  try {
    const ready = await provisionProject(req.project, () => undefined);
    respond(req.id, { ok: true, message: 'Project ' + req.project.name + ' is ready in ' + req.project.workspace + '\n' + ready.summary.join('\n') });
  } catch (e) {
    respond(req.id, { ok: false, message: 'Project ' + req.project.name + ' could not be set up: ' + errMsg(e) });
  } finally {
    pending.starting--;
    maybeShutdown();
  }
};

export const restartSessions = async (req: Extract<GuestRequest, { kind: 'restart' }>): Promise<void> => {
  const targets = [...live.values()].filter((s) => s.status.attach && (req.harness === null || s.status.harness === req.harness) && (!req.cwd || isWithin(req.cwd, s.status.cwd)));
  for (const s of targets) await sendControl({ addresses: ['127.0.0.1'], port: s.status.attach!.port, token: s.status.attach!.token }, FrameType.Restart);
  respond(req.id, { ok: true, message: 'restarted ' + targets.length + ' session(s)' });
};
