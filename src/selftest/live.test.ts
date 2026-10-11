// Live tests on Windows: the real guest session daemon + ptyhost (ConPTY), and the compiled git guard on a real repo.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { GuestResponse, SessionStatus } from '../core/types.js';
import { ensureDir, findOnPath, sleep } from '../core/util.js';
import { connect, encodeFrame, fixWindowsKeys, FrameReader, FrameType, helloFrame, queryViewers } from '../shared/pty-client.js';
import { readJsonFile, writeJsonAtomic } from '../shared/rundir.js';
import type { Fixtures } from './fixtures.js';
import type { Harness } from './harness.js';

const CSC = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
export const liveTestsAvailable = (): boolean => process.platform === 'win32' && fs.existsSync(CSC);

/** Drives the real daemon through the run folder exactly like the host does, with cmd.exe standing in for claude. */
export const daemonTests = async (t: Harness, f: Fixtures, launchPath: string): Promise<void> => {
  const { check, waitFor } = t;
  t.section('live: session daemon + ptyhost');
  const data = f.at('live-data');
  const workspace = f.workA;
  ensureDir(path.join(data, 'tools', 'agents', 'claude'));
  fs.copyFileSync(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'cmd.exe'), path.join(data, 'tools', 'agents', 'claude', 'claude.exe'));
  const sessionFile = path.join(launchPath, 'session.json');
  const session = f.readJson(sessionFile);
  Object.assign(session, { workspace, attach: { enabled: true } });
  Object.assign(session.harness, { arguments: ['/d', '/k', 'echo LIVE-AGENT-READY'], resumeArguments: ['/d', '/k', 'echo LIVE-AGENT-RESUMED'] });
  fs.writeFileSync(sessionFile, JSON.stringify(session));
  const env = { ...process.env, AGENT_LAUNCH_DIR: launchPath, AGENT_DATA_DIR: data, AGENT_WORKSPACE: workspace, AGENT_LOCAL_DIR: f.at('local'), AGENT_LOG_PREFIX: 'daemon', AGENT_NO_TABS: '1' };
  const daemon = spawn(process.execPath, [path.join(launchPath, 'runtime', 'daemon.js')], { env, stdio: 'ignore', windowsHide: true });
  const run = path.join(data, 'run');
  const request = (body: Record<string, unknown>): void => writeJsonAtomic(path.join(run, 'requests', body.id + '.json'), { createdAt: new Date().toISOString(), ...body });
  const response = (id: string): Promise<GuestResponse | null> => waitFor(() => readJsonFile<GuestResponse>(path.join(run, 'responses', id + '.json')));
  try {
    request({ kind: 'session', id: 'live1', harness: 'claude', args: [], cwd: workspace });
    const s = await waitFor(() => { const v = readJsonFile<SessionStatus>(path.join(run, 'sessions', 'live1.json')); return v && v.phase !== 'starting' ? v : null; }, 60000);
    check(s?.phase === 'running' && Boolean(s.attach?.port), 'daemon compiles ptyhost and starts a session on request' + (s?.phase === 'failed' ? ' (' + s.message + ')' : ''));
    if (!s?.attach) return;
    const socket = await connect({ ...s.attach, addresses: ['127.0.0.1'] });
    const reader = new FrameReader();
    let out = '';
    let exitCode: number | null = null;
    socket.on('data', (c: Buffer) => { for (const fr of reader.push(c)) { if (fr.type === FrameType.Output) out += fr.payload.toString(); if (fr.type === FrameType.Exit) exitCode = fr.payload.readInt32LE(0); } });
    socket.write(helloFrame(s.attach.token, 100, 30));
    check(Boolean(await waitFor(() => out.includes('LIVE-AGENT-READY'), 10000)), 'an attached client sees the agent\'s screen');
    socket.write(encodeFrame(FrameType.Input, Buffer.from('echo TYPED-%USERNAME:~0,0%OK\r')));
    check(Boolean(await waitFor(() => out.includes('TYPED-OK'), 10000)), 'keystrokes reach the agent');
    const badClient = await connect({ ...s.attach, addresses: ['127.0.0.1'] });
    const badReader = new FrameReader();
    let denied = '';
    badClient.on('data', (c: Buffer) => { for (const fr of badReader.push(c)) if (fr.type === FrameType.Error) denied = fr.payload.toString(); });
    badClient.write(helloFrame('wrong-token', 80, 24));
    check(Boolean(await waitFor(() => denied, 5000)) && denied.includes('denied'), 'a client with the wrong token is refused');

    const local = { ...s.attach, addresses: ['127.0.0.1'] };
    const first = await queryViewers(local);
    const second = await connect(local);
    second.on('data', () => undefined);
    second.write(helloFrame(s.attach.token, 60, 20));
    const both = await waitFor(async () => ((await queryViewers(local))?.viewers === 2 ? true : null), 5000);
    second.destroy();
    const after = await waitFor(async () => { const v = await queryViewers(local); return v?.viewers === 1 ? v : null; }, 5000);
    const still = readJsonFile<SessionStatus>(path.join(run, 'sessions', 'live1.json'));
    check(first?.viewers === 1 && first.remote === 0 && Boolean(both) && after?.remote === 0 && still?.phase === 'running', 'viewers are counted live: a closed terminal stops counting at once and the session keeps running');
    check(await queryViewers({ ...local, token: 'wrong-token' }) === null, 'the viewer query needs the session token too');
    check(fixWindowsKeys(Buffer.from([0x61, 0x08, 0x7f, 0x1b])).equals(Buffer.from([0x61, 0x7f, 0x08, 0x1b])), 'Windows console Backspace (^H) reaches the agent as DEL, so it deletes one character, not a word');

    request({ kind: 'exec', id: 'exec1', command: ['echo', 'hello from exec'], cwd: workspace, timeoutSeconds: 30 });
    const ex = await response('exec1');
    check(Boolean(ex?.ok && ex.stdout?.includes('hello from exec')), 'exec runs a command in the sandbox and returns its output');
    request({ kind: 'exec', id: 'exec2', command: ['dir'], cwd: 'C:\\Windows', timeoutSeconds: 30 });
    const ex2 = await response('exec2');
    check(ex2?.ok === false && ex2.message.includes('not inside the sandbox workspace'), 'exec refuses folders outside the workspace');
    request({ kind: 'shell', id: 'evil', command: 'calc' });
    request({ kind: 'ping', id: 'ping1' });
    const ping = await response('ping1');
    check(Boolean(ping?.ok) && !fs.existsSync(path.join(run, 'responses', 'evil.json')) && !fs.existsSync(path.join(run, 'requests', 'evil.json')), 'ping answers; unknown request kinds are deleted unanswered');

    request({ kind: 'restart', id: 'restart1', harness: 'claude' });
    check(Boolean(await waitFor(() => out.includes('LIVE-AGENT-RESUMED'), 15000)), 'restart relaunches the agent with its resume arguments while attached');
    socket.write(encodeFrame(FrameType.Input, Buffer.from('exit 3\r')));
    await waitFor(() => exitCode !== null, 10000);
    const ended = await waitFor(() => { const v = readJsonFile<SessionStatus>(path.join(run, 'sessions', 'live1.json')); return v?.phase === 'exited' ? v : null; });
    check(exitCode === 3 && ended?.exitCode === 3, 'the agent\'s exit code reaches the client and the session status');
    socket.destroy();
    badClient.destroy();
  } finally {
    daemon.kill();
    await sleep(500);
  }
};

/** Compiles gitshim.cs and runs real git through it in a scratch repository, as git.exe and through Git Bash. */
export const gitGuardTests = async (t: Harness, f: Fixtures, launchPath: string): Promise<void> => {
  const realGit = findOnPath(['git.exe']);
  t.section('live: git access guard');
  if (!realGit) { console.log('SKIP  git guard (no git.exe on PATH)'); return; }
  const shimDir = f.at('gitshim');
  ensureDir(shimDir);
  const compiled = spawnSync(CSC, ['/nologo', '/optimize', '/out:' + path.join(shimDir, 'git.exe'), path.join(launchPath, 'sandbox', 'gitshim.cs')], { encoding: 'utf8' });
  t.check(compiled.status === 0, 'gitshim.cs compiles with the .NET Framework compiler' + (compiled.status === 0 ? '' : ': ' + compiled.stdout));
  if (compiled.status !== 0) return;
  const repo = f.at('guard-repo');
  ensureDir(repo);
  spawnSync(realGit, ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
  const guard = path.join(launchPath, 'runtime', 'gitguard.js');
  const env = (access: string): NodeJS.ProcessEnv => ({ ...process.env, PATH: shimDir + path.delimiter + process.env.PATH, AGENT_GIT_ACCESS: access, AGENT_REAL_GIT: access === 'readonly' ? realGit : '', AGENT_GUARD_NODE: process.execPath, AGENT_GUARD_SCRIPT: guard, GIT_CONFIG_NOSYSTEM: '1' });
  const git = (access: string, args: string[]) => spawnSync('git', args, { cwd: repo, env: env(access), encoding: 'utf8' });
  const status = git('readonly', ['status', '--porcelain']);
  t.check(status.status === 0 && status.stdout.includes('a.txt'), 'readonly: `git status` works through the git.exe stand-in (exact arguments preserved)');
  const add = git('readonly', ['add', 'a.txt']);
  t.check(add.status === 128 && add.stderr.includes('read-only') && git('readonly', ['status', '--porcelain']).stdout.includes('??'), 'readonly: `git add` is refused and nothing changes');
  const none = git('none', ['status']);
  t.check(none.status === 128 && none.stderr.includes('disabled'), 'none: every git call is refused');
  const bash = [path.join(path.dirname(path.dirname(realGit)), 'bin', 'bash.exe'), path.join(path.dirname(path.dirname(realGit)), 'usr', 'bin', 'bash.exe')].find((b) => fs.existsSync(b));
  if (bash) {
    const bashEnv = t.write(f.at('gitshim', 'bashenv.sh'), 'git() { "' + process.execPath.replace(/\\/g, '/') + '" "' + guard.replace(/\\/g, '/') + '" "$@"; }\nexport -f git\n');
    const viaBash = spawnSync(bash, ['-c', 'git commit -m x'], { cwd: repo, env: { ...env('readonly'), BASH_ENV: bashEnv.replace(/\\/g, '/') }, encoding: 'utf8' });
    t.check(viaBash.status === 128 && viaBash.stderr.includes('read-only'), 'readonly: git inside Git Bash goes through the guard too (BASH_ENV)');
  } else console.log('SKIP  Git Bash check (no bash.exe next to git)');
};
