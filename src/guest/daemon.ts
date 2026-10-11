// Session daemon (runs detached inside the sandbox for its whole life). It is the only thing that acts on host
// requests, and it only knows four request kinds: start a session, run a command, restart sessions, ping.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { GuestRequest, GuestResponse, SessionStatus } from '../core/types.js';
import { FrameType, sendControl } from '../shared/pty-client.js';
import { commandLine, ensurePtyHost, freePort, startPtyHost, waitForPort } from './ptyhost.js';
import { provisionHarness, resolveLaunch, runHooks, saveClaudeMem, guestAddresses } from './provision.js';
import { listRequests, now, readSession, writeJsonAtomic } from '../shared/rundir.js';
import { dataDir, errMsg, exists, isWin, log, run, session, toolsDir, warn, workspace } from './env.js';

const MAX_OUTPUT = 1024 * 1024;
const live = new Map<string, { status: SessionStatus; child: ChildProcess }>();
let lastMemSave = Date.now();

const insideWorkspace = (cwd: string): boolean => {
  const rel = path.relative(workspace.toLowerCase(), path.resolve(cwd).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const respond = (id: string, result: Omit<GuestResponse, 'id' | 'finishedAt'>): void => writeJsonAtomic(run.response(id), { id, ...result, finishedAt: now() });
const saveStatus = (status: SessionStatus): void => writeJsonAtomic(run.session(status.id), { ...status, updatedAt: now() });

const terminalTab = (id: string, title: string, cwd: string): void => {
  const view = [process.execPath, path.join(path.dirname(process.argv[1]), 'view.js'), id];
  const wt = path.join(toolsDir, 'terminal', 'wt.exe');
  if (exists(wt)) spawn(wt, ['-w', '0', 'nt', '--title', title, '-d', cwd, ...view], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd.exe', ['/d', '/c', 'start', title, ...view], { detached: true, stdio: 'ignore', cwd }).unref();
};

const startSession = async (req: Extract<GuestRequest, { kind: 'session' }>): Promise<void> => {
  const status: SessionStatus = { id: req.id, launchId: session.launchId, harness: req.harness, cwd: req.cwd, phase: 'starting', message: 'Starting ' + req.harness, updatedAt: now(), startedAt: now() };
  saveStatus(status);
  try {
    if (!insideWorkspace(req.cwd) || !exists(req.cwd)) throw new Error('Folder is not inside the sandbox workspace ' + workspace + ': ' + req.cwd);
    const harness = req.harness === session.harnessName && session.harness ? session.harness : null;
    if (!harness) throw new Error('Agent "' + req.harness + '" is not configured for this sandbox (it runs ' + session.harnessName + ').');
    provisionHarness(req.harness, harness, process.env);
    const launch = resolveLaunch(req.harness, harness);
    const base = [...launch.args, ...harness.arguments];
    const port = await freePort();
    const token = crypto.randomBytes(24).toString('base64url');
    const env = { ...process.env, ...harness.environment };
    const child = startPtyHost({ exe: ensurePtyHost(), port, token, cols: 120, rows: 32, id: req.id, cwd: req.cwd, env, command: commandLine(launch.file, [...base, ...req.args]), restartCommand: commandLine(launch.file, [...base, ...(harness.resumeArguments ?? [])]) });
    await waitForPort(port, 15000);
    const running: SessionStatus = { ...status, phase: 'running', message: req.harness + ' is running', attach: { addresses: session.networking && session.attach.enabled ? guestAddresses() : [], port, token } };
    live.set(req.id, { status: running, child });
    saveStatus(running);
    log('Session ' + req.id + ' started (' + req.harness + ' in ' + req.cwd + ', port ' + port + ')');
    if (req.id !== session.launchId && process.env.AGENT_NO_TABS !== '1') terminalTab(req.id, req.harness + ' ' + path.basename(req.cwd), req.cwd);
    child.on('exit', (code: number | null) => {
      live.delete(req.id);
      saveStatus({ ...running, phase: 'exited', message: req.harness + ' exited with code ' + code, exitCode: code ?? 1, attach: undefined });
      log('Session ' + req.id + ' ended (exit ' + code + ')');
      try { runHooks('post-agent', process.env); saveClaudeMem(); } catch (e) { warn(errMsg(e)); }
      maybeShutdown();
    });
  } catch (e) {
    saveStatus({ ...status, phase: 'failed', message: errMsg(e) });
    warn('Session ' + req.id + ' failed: ' + errMsg(e));
  }
};

const execCommand = (req: Extract<GuestRequest, { kind: 'exec' }>): void => {
  if (!insideWorkspace(req.cwd) || !exists(req.cwd)) { respond(req.id, { ok: false, message: 'Folder is not inside the sandbox workspace: ' + req.cwd }); return; }
  const line = req.command.map((a) => (/[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a)).join(' ');
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', '"' + line + '"'], { cwd: req.cwd, env: process.env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: Math.min(req.timeoutSeconds, 3600) * 1000, maxBuffer: MAX_OUTPUT * 4 });
  const cap = (s: string | null): string => { const t = s ?? ''; return t.length > MAX_OUTPUT ? t.slice(0, MAX_OUTPUT) + '\n[output truncated]' : t; };
  respond(req.id, { ok: result.status === 0, message: result.error ? errMsg(result.error) : 'exit ' + result.status, exitCode: result.status ?? -1, stdout: cap(result.stdout), stderr: cap(result.stderr) });
};

const restart = async (req: Extract<GuestRequest, { kind: 'restart' }>): Promise<void> => {
  const targets = [...live.values()].filter((s) => req.harness === null || s.status.harness === req.harness);
  for (const s of targets) await sendControl({ addresses: ['127.0.0.1'], port: s.status.attach!.port, token: s.status.attach!.token }, FrameType.Restart);
  respond(req.id, { ok: true, message: 'restarted ' + targets.length + ' session(s)' });
};

const handle = async (req: GuestRequest): Promise<void> => {
  switch (req.kind) {
    case 'session': return startSession(req);
    case 'exec': return execCommand(req);
    case 'restart': return restart(req);
    case 'ping': return respond(req.id, { ok: true, message: 'pong (' + live.size + ' session(s) running)' });
  }
};

/** A headless sandbox with nothing running only wastes RAM, so it shuts itself down. */
const maybeShutdown = (): void => {
  if (!session.headless || live.size > 0 || !isWin) return;
  setTimeout(() => {
    if (live.size > 0 || listRequests(dataDir).length > 0) return;
    log('Headless sandbox has no sessions left; shutting down.');
    saveClaudeMem();
    spawnSync('shutdown.exe', ['/s', '/t', '5'], { windowsHide: true });
  }, 15000);
};

const loop = async (): Promise<void> => {
  // Anything in requests/ that is not a valid request (wrong kind, bad id, junk) is deleted unread.
  for (const file of fs.existsSync(run.requests) ? fs.readdirSync(run.requests) : []) {
    const valid = /^[A-Za-z0-9_-]{1,64}\.json$/.test(file) && listRequests(dataDir).some((r) => r.id + '.json' === file);
    if (!valid && !file.endsWith('.tmp')) fs.rmSync(path.join(run.requests, file), { force: true });
  }
  for (const req of listRequests(dataDir)) {
    fs.rmSync(run.request(req.id), { force: true });
    if (readSession(dataDir, req.id)) continue;
    await handle(req).catch((e: unknown) => respond(req.id, { ok: false, message: errMsg(e) }));
  }
  if (Date.now() - lastMemSave > 120000) { lastMemSave = Date.now(); try { saveClaudeMem(); } catch (e) { warn('claude-mem save failed: ' + errMsg(e)); } }
  setTimeout(() => { void loop(); }, 400);
};

log('Session daemon started (pid ' + process.pid + ').');
fs.writeFileSync(path.join(run.run, 'daemon.pid'), String(process.pid));
void loop();
