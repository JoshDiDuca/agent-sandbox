// Session daemon (runs detached inside the sandbox for its whole life). It is the only thing that acts on host
// requests, and it only knows four request kinds: start a session, run a command, restart sessions, ping.
// It must never die quietly: every iteration is guarded, and anything unexpected is written to its log.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { GuestRequest, GuestResponse, SessionStatus } from '../core/types.js';
import { FrameType, sendControl } from '../shared/pty-client.js';
import { SYSTEM } from '../shared/system.js';
import { commandLine, ensurePtyHost, freePort, ptyHostLogTail, startPtyHost, waitForPtyHost } from './ptyhost.js';
import { provisionHarness, resolveLaunch } from './setup/agents.js';
import { saveClaudeMem } from './setup/claude.js';
import { runHooks } from './setup/hooks.js';
import { guestAddresses } from './setup/network.js';
import { now, readSession, scanRequests, writeJsonAtomic } from '../shared/rundir.js';
import { dataDir, errMsg, exists, isWin, log, run, session, toolsDir, warn, workspace } from './env.js';

const MAX_OUTPUT = 1024 * 1024;
const MAX_MESSAGE = 3500;
const live = new Map<string, { status: SessionStatus; child: ChildProcess }>();
let starting = 0;
let lastMemSave = Date.now();

process.on('uncaughtException', (e) => warn('daemon: unexpected error (continuing): ' + (e.stack ?? errMsg(e))));
process.on('unhandledRejection', (e) => warn('daemon: unexpected error (continuing): ' + errMsg(e)));

const insideWorkspace = (cwd: string): boolean => {
  const rel = path.relative(workspace.toLowerCase(), path.resolve(cwd).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Status/response writes are best-effort: a briefly locked file (antivirus, the host's sync) must not kill the daemon. */
const tryWrite = (file: string, value: unknown): void => { try { writeJsonAtomic(file, value); } catch (e) { warn('Could not write ' + file + ': ' + errMsg(e)); } };
const respond = (id: string, result: Omit<GuestResponse, 'id' | 'finishedAt'>): void => tryWrite(run.response(id), { id, ...result, message: result.message.slice(0, MAX_MESSAGE), finishedAt: now() });
const saveStatus = (status: SessionStatus): void => tryWrite(run.session(status.id), { ...status, message: status.message.slice(0, MAX_MESSAGE), updatedAt: now() });
const safely = (what: string, work: () => void): void => { try { work(); } catch (e) { warn(what + ' failed: ' + errMsg(e)); } };

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

const startSession = async (req: Extract<GuestRequest, { kind: 'session' }>): Promise<void> => {
  const status: SessionStatus = { id: req.id, launchId: session.launchId, harness: req.harness, cwd: req.cwd, phase: 'starting', message: 'Starting ' + req.harness, updatedAt: now(), startedAt: now() };
  saveStatus(status);
  starting++;
  try {
    if (!insideWorkspace(req.cwd) || !exists(req.cwd)) throw new Error('Folder is not inside the sandbox workspace ' + workspace + ': ' + req.cwd);
    const harness = req.harness === session.harnessName && session.harness ? session.harness : null;
    if (!harness) throw new Error('Agent "' + req.harness + '" is not configured for this sandbox (it runs ' + session.harnessName + ').');
    // Never refresh here: main already did, and replacing a running agent's executable would fail.
    provisionHarness(req.harness, harness, process.env, false);
    const launch = resolveLaunch(req.harness, harness);
    const base = [...launch.args, ...harness.arguments];
    const port = await freePort();
    const token = crypto.randomBytes(24).toString('base64url');
    const remote = session.networking && session.attach.enabled;
    const child = startPtyHost({
      exe: ensurePtyHost(), port, token, cols: 120, rows: 32, id: req.id, cwd: req.cwd, env: { ...process.env, ...harness.environment }, remote,
      command: commandLine(launch.file, [...base, ...req.args]), restartCommand: commandLine(launch.file, [...base, ...(harness.resumeArguments ?? [])]),
    });
    try { await waitForPtyHost(child, port, 15000); } catch (e) {
      const tail = ptyHostLogTail(req.id);
      throw new Error(errMsg(e) + (tail ? '. From its log:\n' + tail : '') + '\nLog: ' + path.join(dataDir, 'logs', 'ptyhost-' + req.id + '.log'));
    }
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
    starting--;
  }
};

const quoteForCmd = (a: string): string => (/[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a);

/** Runs a command for the host without blocking the daemon (other requests and pings keep being answered). */
const execCommand = (req: Extract<GuestRequest, { kind: 'exec' }>): void => {
  if (!insideWorkspace(req.cwd) || !exists(req.cwd)) { respond(req.id, { ok: false, message: 'Folder is not inside the sandbox workspace: ' + req.cwd }); return; }
  const child = spawn(SYSTEM.cmd(), ['/d', '/s', '/c', '"' + req.command.map(quoteForCmd).join(' ') + '"'], { cwd: req.cwd, env: process.env, windowsHide: true, windowsVerbatimArguments: true });
  const output = { stdout: '', stderr: '' };
  const collect = (key: 'stdout' | 'stderr') => (d: Buffer): void => { if (output[key].length < MAX_OUTPUT) output[key] += d.toString('utf8'); };
  child.stdout.on('data', collect('stdout'));
  child.stderr.on('data', collect('stderr'));
  const timer = setTimeout(() => child.kill(), Math.min(req.timeoutSeconds, 3600) * 1000);
  const cap = (s: string): string => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n[output truncated]' : s);
  child.on('error', (e) => { clearTimeout(timer); respond(req.id, { ok: false, message: 'Could not run the command: ' + errMsg(e) }); });
  child.on('close', (code) => {
    clearTimeout(timer);
    respond(req.id, { ok: code === 0, message: code === null ? 'stopped after ' + req.timeoutSeconds + ' s' : 'exit ' + code, exitCode: code ?? -1, stdout: cap(output.stdout), stderr: cap(output.stderr) });
  });
};

const restart = async (req: Extract<GuestRequest, { kind: 'restart' }>): Promise<void> => {
  const targets = [...live.values()].filter((s) => s.status.attach && (req.harness === null || s.status.harness === req.harness));
  for (const s of targets) await sendControl({ addresses: ['127.0.0.1'], port: s.status.attach!.port, token: s.status.attach!.token }, FrameType.Restart);
  respond(req.id, { ok: true, message: 'restarted ' + targets.length + ' session(s)' });
};

const handle = (req: GuestRequest): Promise<void> | void => {
  switch (req.kind) {
    case 'session': return startSession(req);
    case 'exec': return execCommand(req);
    case 'restart': return restart(req);
    case 'ping': return respond(req.id, { ok: true, message: 'pong (' + live.size + ' session(s) running)' });
  }
};

/** A headless sandbox with nothing running (or starting) only wastes RAM, so it shuts itself down. */
const maybeShutdown = (): void => {
  if (!session.headless || !isWin) return;
  const idle = (): boolean => live.size === 0 && starting === 0 && scanRequests(dataDir).valid.length === 0;
  if (!idle()) return;
  setTimeout(() => {
    if (!idle()) return;
    log('Headless sandbox has no sessions left; shutting down.');
    safely('claude-mem save', saveClaudeMem);
    spawnSync(SYSTEM.shutdown(), ['/s', '/t', '5'], { windowsHide: true });
  }, 15000);
};

const tick = (): void => {
  const { valid, invalid } = scanRequests(dataDir);
  // Anything in requests/ that is not a valid request (wrong kind, bad id, junk) is deleted unread.
  for (const file of invalid) safely('removing an invalid request', () => fs.rmSync(file, { recursive: true, force: true }));
  for (const req of valid) {
    safely('claiming a request', () => fs.rmSync(run.request(req.id), { force: true }));
    if (readSession(dataDir, req.id)) continue;
    // Not awaited: starting a session or running a command must not hold up other requests.
    void Promise.resolve(handle(req)).catch((e: unknown) => respond(req.id, { ok: false, message: errMsg(e) }));
  }
  if (Date.now() - lastMemSave > 120000) { lastMemSave = Date.now(); safely('claude-mem save', saveClaudeMem); }
};

const loop = (): void => {
  try { tick(); } catch (e) { warn('daemon loop: ' + errMsg(e)); } finally { setTimeout(loop, 400); }
};

log('Session daemon started (pid ' + process.pid + ').');
loop();
