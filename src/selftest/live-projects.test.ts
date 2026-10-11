// Live: the real session daemon + ptyhost with two projects at once. The launch folder (A) and a project in a root
// (B) each get two sessions requested at the same moment; each runs in its own folder with its own environment; B is
// set up once for both; viewers attach, detach and reattach, two at a time; exec and restart follow the project.
// Toolchain installers run as a dry run (no downloads); everything else is real. cmd.exe stands in for the agent.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type net from 'node:net';
import type { GuestResponse, SessionStatus } from '../core/types.js';
import { ensureDir, sleep } from '../core/util.js';
import { projectSpec } from '../host/join.js';
import { connect, encodeFrame, FrameReader, FrameType, helloFrame, queryViewers, resizeFrame } from '../shared/pty-client.js';
import { readJsonFile, writeJsonAtomic } from '../shared/rundir.js';
import type { Fixtures } from './fixtures.js';
import type { Harness } from './harness.js';

interface Viewer { socket: net.Socket; out: () => string; exitCode: () => number | null }

export const multiProjectDaemonTests = async (t: Harness, f: Fixtures, launchPath: string): Promise<void> => {
  const { check, waitFor } = t;
  t.section('live: two projects, several sessions, several viewers');
  const data = f.at('live-multi-data');
  const root = f.at('live-root');
  const projB = path.join(root, 'projB');
  ensureDir(projB);
  ensureDir(path.join(data, 'tools', 'agents', 'claude'));
  fs.copyFileSync(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'cmd.exe'), path.join(data, 'tools', 'agents', 'claude', 'claude.exe'));
  const sessionFile = path.join(launchPath, 'session.json');
  const session = f.readJson(sessionFile);
  // B's root appears at its own path here (like guestWorkspace "mirror"), so host and guest paths are the same.
  Object.assign(session, { workspace: f.workA, attach: { enabled: true }, projectsDir: f.at('live-projects'), roots: [root], projectId: 'work-a' });
  Object.assign(session.harness, { arguments: ['/d', '/k', 'echo AGENT-READY'], resumeArguments: ['/d', '/k', 'echo AGENT-RESUMED'] });
  fs.writeFileSync(sessionFile, JSON.stringify(session));
  const local = f.at('live-multi-local');
  const env = { ...process.env, AGENT_LAUNCH_DIR: launchPath, AGENT_DATA_DIR: data, AGENT_WORKSPACE: f.workA, AGENT_LOCAL_DIR: local, AGENT_LOG_PREFIX: 'daemon', AGENT_NO_TABS: '1', AGENT_DRY_RUN: '1', AGENT_MANAGED_DIR: f.at('live-managed') };
  const daemon = spawn(process.execPath, [path.join(launchPath, 'runtime', 'daemon.js')], { env, stdio: 'ignore', windowsHide: true });
  const run = path.join(data, 'run');
  const request = (body: Record<string, unknown>): void => writeJsonAtomic(path.join(run, 'requests', body.id + '.json'), { createdAt: new Date().toISOString(), ...body });
  const response = (id: string): Promise<GuestResponse | null> => waitFor(() => readJsonFile<GuestResponse>(path.join(run, 'responses', id + '.json')), 60000);
  const status = (id: string): SessionStatus | null => readJsonFile<SessionStatus>(path.join(run, 'sessions', id + '.json'));
  const started = (id: string) => waitFor(() => { const s = status(id); return s && s.phase !== 'starting' ? s : null; }, 90000);
  const viewers: Viewer[] = [];
  const view = async (s: SessionStatus, cols = 100): Promise<Viewer> => {
    const socket = await connect({ ...s.attach!, addresses: ['127.0.0.1'] });
    const reader = new FrameReader();
    let out = '';
    let exit: number | null = null;
    socket.on('data', (chunk: Buffer) => { for (const fr of reader.push(chunk)) { if (fr.type === FrameType.Output) out += fr.payload.toString(); if (fr.type === FrameType.Exit) exit = fr.payload.readInt32LE(0); } });
    socket.on('error', () => undefined);
    socket.write(helloFrame(s.attach!.token, cols, 30));
    const v = { socket, out: () => out, exitCode: () => exit };
    viewers.push(v);
    return v;
  };
  const type = (v: Viewer, text: string): void => { v.socket.write(encodeFrame(FrameType.Input, Buffer.from(text + '\r'))); };
  const sees = (v: Viewer, needle: string, ms = 15000) => waitFor(() => v.out().includes(needle), ms);

  try {
    const cfg = structuredClone(f.baseConfig);
    cfg.toolchains.environment = { LIVE_B: 'b-env' };
    const spec = projectSpec(await f.run({ cwd: projB, trustConfig: true }, cfg), { name: 'projB', host: projB, guest: projB, primary: false, mechanism: 'root', registeredAt: '' }, false);
    // All four at the same moment: two in the launch folder, two in B (whose setup they share).
    request({ kind: 'session', id: 'a1', harness: 'claude', args: [], cwd: f.workA });
    request({ kind: 'session', id: 'b1', harness: 'claude', args: [], cwd: projB, project: spec });
    request({ kind: 'session', id: 'b2', harness: 'claude', args: [], cwd: projB, project: spec });
    request({ kind: 'session', id: 'a2', harness: 'claude', args: [], cwd: f.workA });
    const [a1, a2, b1, b2] = await Promise.all(['a1', 'a2', 'b1', 'b2'].map(started));
    const all = [a1, a2, b1, b2];
    check(all.every((s) => s?.phase === 'running' && s.attach?.port), 'four sessions requested at once all start (two per project)' + all.filter((s) => s?.phase !== 'running').map((s) => ' [' + s?.id + ': ' + s?.message + ']').join(''));
    if (!all.every((s) => s?.attach)) return;
    check(a1!.project === 'work-a' && b1!.project === 'projB' && b2!.project === 'projB', 'each session knows its project');
    const log = fs.readdirSync(path.join(data, 'logs')).filter((n) => n.startsWith('daemon')).map((n) => fs.readFileSync(path.join(data, 'logs', n), 'utf8')).join('\n');
    check((log.match(/Project projB: setting up/g) ?? []).length === 1, 'two sessions for the same new project at once share one setup (no second provisioning run)');
    const proj = readJsonFile<{ phase: string }>(path.join(run, 'projects', 'projB.json'));
    check(proj?.phase === 'ready', 'the project\'s setup status is written for the host (sandbox status)');

    // Each session: its own folder and environment.
    const views = await Promise.all(all.map((s) => view(s!)));
    for (const v of views) await sees(v, 'AGENT-READY');
    for (const v of views) type(v, 'echo P=%AGENT_PROJECT% W=%AGENT_WORKSPACE% B=[%LIVE_B%]');
    check(Boolean(await sees(views[2], 'P=projB W=' + projB + ' B=[b-env]')) && Boolean(await sees(views[3], 'B=[b-env]')), 'B\'s sessions run with B\'s environment (its workspace, project and variables)');
    // (The daemon here runs without the boot's environment, so A's own AGENT_* variables are not set at all.)
    check(Boolean(await sees(views[0], 'B=[%LIVE_B%]')) && Boolean(await sees(views[1], 'B=[%LIVE_B%]')), 'A\'s sessions are untouched by B (B\'s variables never reach them)');
    type(views[2], 'echo CWD=%CD%.');
    check(Boolean(await sees(views[2], 'CWD=' + projB + '.')), 'B\'s session starts in B\'s folder');

    // A second viewer on one session; then the first one goes away and comes back.
    const second = await view(b1!, 60);
    let counted: number | undefined;
    await waitFor(async () => { counted = (await queryViewers({ ...b1!.attach!, addresses: ['127.0.0.1'] }))?.viewers; return counted === 2; }, 10000);
    check(counted === 2, 'a second viewer attaches to the same session (viewers: ' + counted + ')');
    second.socket.write(resizeFrame(90, 25));
    type(views[2], 'echo TWO-VIEWERS-OK');
    check(Boolean(await sees(views[2], 'TWO-VIEWERS-OK')) && Boolean(await sees(second, 'TWO-VIEWERS-OK')), 'both viewers see what is typed in either (and a resize from the second keeps it working)');
    type(second, 'echo FROM-SECOND');
    check(Boolean(await sees(views[2], 'FROM-SECOND')), 'input from the second viewer reaches the agent and the first viewer');
    views[2].socket.destroy();
    second.socket.destroy();
    await waitFor(async () => (await queryViewers({ ...b1!.attach!, addresses: ['127.0.0.1'] }))?.viewers === 0, 10000);
    check(status('b1')?.phase === 'running', 'closing every viewer never ends the session');
    for (let round = 1; round <= 3; round++) {
      const again = await view(b1!);
      type(again, 'echo REATTACHED-' + round);
      check(Boolean(await sees(again, 'REATTACHED-' + round)), 'reattach ' + round + ': a new viewer works on the same session');
      again.socket.destroy();
    }

    // exec, restart and refusals follow the projects.
    request({ kind: 'exec', id: 'xb', command: ['echo', '%LIVE_B%'], cwd: projB, timeoutSeconds: 30 });
    request({ kind: 'exec', id: 'xa', command: ['echo', '[%LIVE_B%]'], cwd: f.workA, timeoutSeconds: 30 });
    const [xb, xa] = await Promise.all([response('xb'), response('xa')]);
    check(Boolean(xb?.stdout?.includes('b-env')) && Boolean(xa?.stdout?.includes('[%LIVE_B%]')), 'exec in B\'s folder gets B\'s environment; in A\'s folder, A\'s');
    request({ kind: 'session', id: 'bad1', harness: 'claude', args: [], cwd: f.workB, project: { ...spec, name: 'outside', workspace: f.workB } });
    const bad = await started('bad1');
    check(bad?.phase === 'failed' && bad.message.includes('not visible inside the sandbox'), 'a project outside the launch folder, the roots and C:\\Projects is refused');
    request({ kind: 'session', id: 'bad2', harness: 'claude', args: [], cwd: f.workA, project: spec });
    check((await started('bad2'))?.message.includes('not inside project projB') === true, 'a session cannot claim a project its folder is not in');
    request({ kind: 'restart', id: 'rb', harness: null, cwd: projB });
    check((await response('rb'))?.message === 'restarted 2 session(s)', 'restart scoped to a project restarts only its sessions');
    check(fs.existsSync(path.join(local, 'projects', 'projB', 'shell.cmd')) && fs.readFileSync(path.join(local, 'projects', 'projB', 'env.cmd'), 'utf8').includes('LIVE_B=b-env') && fs.existsSync(path.join(local, 'bin', 'sbx-shell.cmd')), 'sbx-shell projB opens a terminal inside with B\'s folder and environment');
  } finally {
    for (const v of viewers) v.socket.destroy();
    // End every agent: a fresh viewer types exit into each still-running session.
    for (const id of ['a1', 'a2', 'b1', 'b2']) {
      const s = status(id);
      if (s?.phase !== 'running' || !s.attach) continue;
      try { const v = await view(s); type(v, 'exit'); await waitFor(() => v.exitCode() !== null, 5000); v.socket.destroy(); } catch { /* already gone */ }
    }
    daemon.kill();
    await sleep(500);
  }
};
