// `agent-sandbox self-test`: offline logic tests, plus live tests of the ptyhost bridge and the guest session daemon
// when running on Windows (they need csc.exe and ConPTY, both part of Windows 10/11).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { Config, GuestResponse, HostProbe, ResolvedRun, RunRequest, SessionStatus } from '../core/types.js';
import { parseArgs } from '../cli/args.js';
import { activateAccount, activeAccount, listAccounts, readAccount, saveAccount, setDefaultAccount, defaultAccount, removeAccount } from '../host/accounts.js';
import { isSandboxAddress } from '../host/channel.js';
import { pruneStorage } from '../host/cleanup.js';
import { DEFAULTS, loadConfig } from '../core/config.js';
import { connect, encodeFrame, FrameReader, FrameType, helloFrame } from '../shared/pty-client.js';
import { readJsonFile, safeId, validRequest, validSession, writeJsonAtomic } from '../shared/rundir.js';
import { buildFirewallCommands, cidrToRange, parseDefaultGateways, parseDnsServers, subtractIps } from '../shared/netrules.js';
import { pickNodeVersion, pickPackageVersion } from '../guest/toolchains.js';
import { syncClaudeMem, syncHistoryIn, syncHistoryOut, translatePaths, type SyncState } from '../sync/history.js';
import { toRegFile } from '../host/personalize.js';
import { buildWsb, generateSandbox, resolveMemoryMb } from '../host/generate.js';
import { ensureDir, errMsg, isWin, sleep } from '../core/util.js';
import { autoGuestWorkspace, resolveRun } from '../core/workspace.js';

const CSC = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

export const selfTest = async (packageRoot: string): Promise<number> => {
  let failures = 0;
  const check = (ok: boolean, name: string): void => { console.log((ok ? '\x1b[32mPASS\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m  ') + name); if (!ok) failures++; };
  const rejects = async (fn: () => unknown, needle: string): Promise<boolean> => { try { await fn(); return false; } catch (e) { return errMsg(e).includes(needle); } };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sandbox-test-'));
  const write = (file: string, content: string): string => { ensureDir(path.dirname(file)); fs.writeFileSync(file, content); return file; };
  const originalWindir = process.env.WINDIR;
  const originalHome = process.env.AGENT_SANDBOX_HOME;
  process.env.AGENT_SANDBOX_HOME = path.join(temp, 'user-home');

  try {
    // ---- config ---------------------------------------------------------------------------------------------------
    const builtIn = loadConfig();
    check(builtIn.configPath === null && builtIn.config.guestWorkspace === 'auto' && builtIn.config.sandbox.headless === false && builtIn.config.attach.enabled, 'no user config: built-in defaults (auto guest folder, headless off, attach on)');
    const userFile = write(path.join(temp, 'cfg.json'), JSON.stringify({ storage: { root: path.join(temp, 'storage'), dataName: 'testdata' }, sandbox: { headless: true }, toolchains: { rust: { enabled: false } } }));
    const custom = loadConfig(userFile);
    check(custom.config.sandbox.headless && !custom.config.toolchains.rust.enabled && custom.config.toolchains.python.enabled && custom.config.sandbox.vGpu, 'a config file only needs the keys it changes (deep merge over defaults)');
    check(await rejects(() => loadConfig(path.join(temp, 'missing.json')), 'Config not found'), 'an explicit --config that does not exist is an error');
    check(fs.existsSync(path.join(packageRoot, 'config.example.json')) && loadConfig(path.join(packageRoot, 'config.example.json')).config.defaultHarness === 'claude', 'config.example.json is valid');

    // ---- arguments ------------------------------------------------------------------------------------------------
    const wrapped = parseArgs(['--terminal', '--continue', '--headless', '--node', '20', '--', '--terminal'], true);
    check(wrapped.command === 'launch' && wrapped.terminal && wrapped.headless === true && wrapped.node === '20' && wrapped.passthrough.join(' ') === '--continue --terminal', 'claude-sbx: sandbox flags are consumed, everything else goes to the agent');
    check(await rejects(() => parseArgs(['launch', '--bogus']), 'Unknown option') && parseArgs(['account', 'use', 'work', '--no-restart']).positionals.join() === 'use,work', 'agent-sandbox: unknown options are errors, positionals are kept');

    // ---- workspace resolution -------------------------------------------------------------------------------------
    const hostNode = path.join(temp, 'host-node');
    write(path.join(hostNode, 'node.exe'), 'x');
    write(path.join(hostNode, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    const hostClaude = path.join(temp, 'host-claude');
    write(path.join(hostClaude, 'claude.exe'), 'fake-claude');
    const hostProfile = path.join(temp, 'host-dot-claude');
    write(path.join(hostProfile, 'settings.json'), '{ "theme": "dark" }');
    write(path.join(hostProfile, 'CLAUDE.md'), 'my rules');
    write(path.join(hostProfile, 'commands', 'review.md'), 'review cmd');
    write(path.join(hostProfile, 'plugins', 'installed_plugins.json'), JSON.stringify({ path: hostProfile + '\\plugins\\cache\\claude-mem' }));
    write(path.join(hostProfile, '.credentials.json'), '{ "token": "secret" }');
    const hostGlobalState = write(path.join(temp, 'host-claude.json'), '{ "hasCompletedOnboarding": true }');
    const install = path.join(temp, 'install');
    ensureDir(path.join(install, 'sub'));
    const workA = path.join(temp, 'work-a');
    const workB = path.join(temp, 'work-b');
    const shared = path.join(temp, 'shared');
    for (const d of [workA, workB, shared, path.join(workB, 'assets')]) ensureDir(d);
    write(path.join(workB, 'setup.mjs'), "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.AGENT_DATA, 'hook-ran.txt'), process.env.AGENT_WORKSPACE);\n");

    const makeConfig = (copyFromHost: boolean): Config => {
      const c = structuredClone(DEFAULTS);
      c.storage.root = path.join(temp, 'storage');
      c.storage.dataName = 'testdata';
      c.sandbox.memoryMb = 8192;
      c.provisioning.copyFromHost = copyFromHost;
      c.provisioning.terminal.enabled = false;
      c.harnesses.claude.hostDir = hostClaude;
      c.claudeProfile = { ...c.claudeProfile, hostDir: hostProfile, globalStateFile: hostGlobalState };
      c.personalization.enabled = false;
      c.mappings = [{ host: path.join(temp, 'missing-optional'), guest: 'C:\\GameSources\\Missing', readOnly: true, optional: true }];
      return c;
    };
    const baseConfig = makeConfig(true);
    const loadedFor = (config: Config): RunRequest['loaded'] => ({ config, configPath: null, base: temp });
    const run = (over: Partial<RunRequest> = {}, config: Config = baseConfig): Promise<ResolvedRun> => resolveRun({ packageRoot: install, loaded: loadedFor(config), cwd: workA, noAgent: false, noLocalConfig: false, trustConfig: false, scripts: [], ...over }, 'v22.3.0');
    const probe: HostProbe = { nodeDir: hostNode, harnessExe: { dir: hostClaude, file: 'claude.exe' }, gitDir: null, nvmDir: null, hostNodeVersion: 'v22.3.0' };
    const generate = (r: ResolvedRun, args: string[] = [], p = probe): ReturnType<typeof generateSandbox> => generateSandbox({ packageRoot, run: r, harnessArgs: args, probe: p });
    const writeLocal = (dir: string, content: unknown): void => { write(path.join(dir, '.sandbox-config.json'), typeof content === 'string' ? content : JSON.stringify(content)); };

    const rA = await run();
    check(rA.workspaceHost === workA && rA.config.guestWorkspace === 'C:\\Workspace\\work-a' && rA.harnessName === 'claude' && rA.dataPath.endsWith(path.join('data', 'testdata')), 'any folder is the workspace; guest path is C:\\Workspace\\<folder name>');
    check(autoGuestWorkspace('C:\\x\\My Proj (2)') === 'C:\\Workspace\\My Proj _2_' && autoGuestWorkspace('D:\\...') === 'C:\\Workspace\\project', 'auto guest folder names are sanitised');
    check(rA.versions.node.spec === '22.3.0' && rA.versions.node.source === 'this PC' && rA.versions.python.spec === '3', 'default Node version is this PC\'s; Python defaults to latest 3.x');
    write(path.join(workA, '.nvmrc'), 'lts/iron\n');
    write(path.join(workA, '.python-version'), '3.11\n');
    const rV = await run();
    check(rV.versions.node.spec === 'lts/iron' && rV.versions.node.source === '.nvmrc' && rV.versions.python.spec === '3.11', '.nvmrc and .python-version are respected');
    check((await run({ nodeVersion: '18' })).versions.node.source === 'command line', '--node beats .nvmrc');
    fs.rmSync(path.join(workA, '.nvmrc'));
    fs.rmSync(path.join(workA, '.python-version'));
    write(path.join(workA, '.node-version'), 'v20.11.1');
    check((await run()).versions.node.spec === 'v20.11.1', '.node-version is respected');
    fs.rmSync(path.join(workA, '.node-version'));

    ensureDir(path.join(temp, 'storage'));
    check(await rejects(() => run({ cwd: install }), 'install folder') && await rejects(() => run({ cwd: temp }), 'could modify it') && await rejects(() => run({ cwd: path.join(temp, 'storage') }), 'storage folder'), 'refuses the install folder, its parents and the storage folder');
    ensureDir(path.join(temp, 'winroot', 'sys'));
    process.env.WINDIR = path.join(temp, 'winroot');
    const sysRefused = await rejects(() => run({ cwd: path.join(temp, 'winroot', 'sys') }), 'system folder');
    process.env.WINDIR = originalWindir;
    check(sysRefused && await rejects(() => run({ cwd: path.parse(temp).root }), 'drive root'), 'refuses system folders and drive roots');

    // ---- .sandbox-config.json -------------------------------------------------------------------------------------
    const localB = { _comment: 'x', harness: 'codex', sandbox: { memoryMb: 4096, networking: false, headless: true }, toolchains: { node: { version: '18' }, rust: { enabled: false } }, mappings: [{ host: './assets', guest: 'C:\\Assets', readOnly: true }, { host: '../shared', guest: 'C:\\Shared', readOnly: false }], scripts: ['./setup.mjs'] };
    writeLocal(workB, localB);
    check(await rejects(() => run({ cwd: workB }), '--trust-config') && await rejects(() => run({ cwd: workB }), 'READ/WRITE'), 'an untrusted .sandbox-config.json is refused and its effects are listed');
    check(await rejects(() => run({ cwd: workB, ask: async () => false }), 'Untrusted'), 'answering "no" refuses it');
    const rB = await run({ cwd: workB, ask: async () => true });
    check(rB.harnessName === 'codex' && rB.config.sandbox.memoryMb === 4096 && rB.config.sandbox.headless && !rB.config.toolchains.rust.enabled && rB.config.toolchains.python.enabled && rB.versions.node.source === '.sandbox-config.json', 'approved local settings apply over the defaults (incl. toolchains, headless)');
    check(rB.config.mappings.some((m) => m.host === shared && !m.readOnly) && rB.scripts.includes(path.join(workB, 'setup.mjs')), 'relative paths resolve against the folder of .sandbox-config.json');
    check((await run({ cwd: workB })).harnessName === 'codex' && (await run({ cwd: workB, noLocalConfig: true })).harnessName === 'claude' && (await run({ cwd: workB, harness: 'gemini' })).harnessName === 'gemini', 'approval is remembered; --no-local-config and --harness win');
    check((await run({ cwd: workB, headless: false })).config.sandbox.headless === false, '--window beats a local headless setting');
    writeLocal(workB, { ...localB, sandbox: { memoryMb: 6144 } });
    check(await rejects(() => run({ cwd: workB }), 'Untrusted'), 'changing the file requires approval again');
    const dirC = path.join(temp, 'work-c');
    ensureDir(dirC);
    const bad = async (content: unknown, needle: string): Promise<boolean> => { writeLocal(dirC, content); return rejects(() => run({ cwd: dirC, trustConfig: true }), needle); };
    check(await bad({ storage: { root: 'C:\\x' } }, 'storage is not an allowed') && await bad({ harnesses: {} }, 'harnesses is not an allowed'), 'local file cannot change storage or agent executables');
    check(await bad({ claudeProfile: { hostDir: 'C:\\x' } }, 'claudeProfile.hostDir is not allowed') && await bad({ toolchains: { node: { hostDir: 'x' } } }, 'toolchains.node.hostDir is not allowed'), 'local file cannot point at host folders');
    check(await bad({ sandbox: { memoryMb: 12 } }, 'sandbox.memoryMb has the wrong') && await bad({ mappings: [{ host: 'x', guest: 'C:\\Windows\\x', readOnly: true }] }, 'reserved guest path'), 'values are type-checked; reserved guest paths are rejected');
    writeLocal(dirC, { claudeProfile: { copyCredentials: true }, network: { blockPrivateRanges: false } });
    check(await rejects(() => run({ cwd: dirC }), 'copies your Claude LOGIN') && await rejects(() => run({ cwd: dirC }), 'turns OFF the LAN block'), 'risky settings are called out before approval');
    fs.rmSync(path.join(dirC, '.sandbox-config.json'));

    // ---- generated sandbox ----------------------------------------------------------------------------------------
    const genA = generate(rA, ['--version'], { ...probe, gitDir: shared, nvmDir: workB });
    const wsb = fs.readFileSync(genA.wsbPath, 'utf8');
    check(wsb.includes('<MemoryInMB>8192</MemoryInMB>') && wsb.includes('<SandboxFolder>C:\\Workspace\\work-a</SandboxFolder>') && wsb.includes('C:\\HostTools\\git') && wsb.includes('C:\\HostTools\\nvm') && !wsb.includes('Missing') && wsb.includes('logon.cmd</Command>'), 'wsb: memory, workspace, host git/nvm, optional mapping skipped, logon command');
    const files = ['guest/main.js', 'guest/daemon.js', 'guest/view.js', 'guest/ptyclient.js', 'guest/toolchains.js', 'guest/package.json', 'sandbox/bootstrap.ps1', 'sandbox/logon.cmd', 'sandbox/ptyhost.cs'];
    check(files.every((f) => fs.existsSync(path.join(genA.launchPath, f))), 'launch folder has the guest runner, daemon, view, ptyhost source and boot scripts');
    const logon = fs.readFileSync(path.join(genA.launchPath, 'sandbox', 'logon.cmd'), 'utf8');
    check(logon.includes('tools\\terminal\\wt.exe') && logon.includes('bootstrap.ps1') && logon.includes('-NoExit'), 'logon.cmd opens Windows Terminal (falls back to PowerShell)');
    const session = JSON.parse(fs.readFileSync(genA.sessionPath, 'utf8'));
    check(session.launchId === genA.launchId && session.workspace === 'C:\\Workspace\\work-a' && session.workspaceHost === workA && session.harnessArguments[0] === '--version' && session.hostTools.git && session.hostTools.nvm && session.versions.node.spec === '22.3.0' && session.headless === false, 'session.json carries ids, paths, versions and host tools');
    const staged = path.join(genA.launchPath, 'claude-profile');
    check(['settings.json', 'CLAUDE.md', '.claude.json', 'plugins'].every((f) => fs.existsSync(path.join(staged, f))) && !fs.existsSync(path.join(staged, '.credentials.json')), 'Claude settings and plugins staged; login is not');
    check(buildWsb(baseConfig, 4096, [{ host: 'C:\\a&b', guest: 'C:\\X', readOnly: true }]).includes('C:\\a&amp;b'), 'wsb values are XML-escaped');
    check(resolveMemoryMb({ ...baseConfig.sandbox, memoryMb: 'auto' }, 40000 * 1048576) === 31744 && await rejects(() => resolveMemoryMb({ ...baseConfig.sandbox, memoryMb: 'auto' }, 9000 * 1048576), 'Not enough free RAM'), "memory 'auto' follows free RAM minus reserve");

    // ---- guest runner (dry run) -----------------------------------------------------------------------------------
    const runGuest = (launchPath: string, data: string, workspace: string, extra: Record<string, string> = {}): { status: number | null; out: string } => {
      const r = spawnSync(process.execPath, [path.join(launchPath, 'guest', 'main.js')], { encoding: 'utf8', env: { ...process.env, AGENT_LAUNCH_DIR: launchPath, AGENT_DATA_DIR: data, AGENT_HOST_TOOLS_DIR: path.join(temp, 'host-tools'), AGENT_WORKSPACE: workspace, AGENT_LOCAL_DIR: path.join(temp, 'local'), AGENT_MANAGED_DIR: path.join(temp, 'managed'), AGENT_DRY_RUN: '1', ...extra } });
      return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
    };
    write(path.join(temp, 'host-tools', 'agents', 'claude', 'claude.exe'), 'fake-claude');
    const data1 = path.join(temp, 'data1');
    const r1 = runGuest(genA.launchPath, data1, workA, { AGENT_TEST_EXEMPT: '172.28.0.1' });
    check(r1.status === 0 && r1.out.includes('would run:') && r1.out.includes('--version') && r1.out.includes('cwd=' + workA), 'guest starts the agent with its arguments in the workspace' + (r1.status === 0 ? '' : '\n' + r1.out));
    check(r1.out.includes('would provision nvm and Node 22.3.0 (from this PC)') && r1.out.includes('would provision Python 3') && r1.out.includes('would provision Rust') && r1.out.includes('.NET SDK') && r1.out.includes('would provision bun') && r1.out.includes('would provision Git for Windows from this PC'), 'guest provisions nvm/Node, Python, Rust, .NET, Bun, Git');
    const claudeState = path.join(data1, 'state', 'claude');
    check(fs.readFileSync(path.join(claudeState, 'settings.json'), 'utf8').includes('dark') && fs.existsSync(path.join(claudeState, 'commands', 'review.md')) && !fs.existsSync(path.join(claudeState, '.credentials.json')), 'guest applied host Claude settings (no login)');
    check(fs.readFileSync(path.join(claudeState, 'plugins', 'installed_plugins.json'), 'utf8').includes(JSON.stringify(claudeState).slice(1, -1)), 'plugin manifests are re-pointed at the sandbox Claude folder');
    const manifest = fs.readFileSync(path.join(temp, 'managed', 'CLAUDE.md'), 'utf8');
    check(manifest.includes('DISPOSABLE Windows Sandbox') && manifest.includes(workA) && manifest.split('\n').length < 16 && fs.readFileSync(path.join(claudeState, 'CLAUDE.md'), 'utf8') === 'my rules' && fs.existsSync(path.join(data1, 'SANDBOX.md')), 'agent manifest goes to the managed CLAUDE.md (tiny); the user CLAUDE.md is untouched');
    check(r1.out.includes('AgentSandbox-Block-Private') && r1.out.includes('remoteport=1-52,54-65535'), 'guest firewall plan blocks the LAN but keeps DNS to the gateway');
    check(readJsonFile<{ phase: string }>(path.join(data1, 'run', 'sandbox.json'))?.phase === 'ready', 'guest reports "ready" in run/sandbox.json');
    const genHook = generate(await run({ cwd: workB, harness: 'claude', trustConfig: true }));
    const rHook = runGuest(genHook.launchPath, path.join(temp, 'data-hook'), workB);
    check(rHook.status === 0 && fs.readFileSync(path.join(temp, 'data-hook', 'hook-ran.txt'), 'utf8') === workB, 'local "scripts" run inside the sandbox with the workspace set');
    const genInstall = generate(await run({}, makeConfig(false)), [], { ...probe, nodeDir: null, harnessExe: null });
    const r3 = runGuest(genInstall.launchPath, path.join(temp, 'data3'), workA, { AGENT_HOST_TOOLS_DIR: path.join(temp, 'empty') });
    check(r3.status === 0 && r3.out.includes('npm-cli.js') && r3.out.includes('@anthropic-ai/claude-code') && !fs.readFileSync(genInstall.wsbPath, 'utf8').includes('HostTools'), 'install mode: nothing mapped from this PC, agent installed with npm');
    const r5 = runGuest(generate(await run({ noAgent: true })).launchPath, path.join(temp, 'data5'), workA);
    check(r5.status === 0 && r5.out.includes('no agent requested'), '--no-agent provisions without an agent');

    // ---- history and claude-mem sync ------------------------------------------------------------------------------
    const hostWs = 'D:\\Code\\my-app';
    const guestWs = 'C:\\Workspace\\my-app';
    check(translatePaths('{"cwd":"D:\\\\Code\\\\my-app","f":"D:\\\\Code\\\\my-app\\\\src\\\\a.ts","o":"D:\\\\Code\\\\my-app2"}', hostWs, guestWs) === '{"cwd":"C:\\\\Workspace\\\\my-app","f":"C:\\\\Workspace\\\\my-app\\\\src\\\\a.ts","o":"D:\\\\Code\\\\my-app2"}', 'paths are translated as whole paths only (my-app2 untouched)');
    const hostDot = path.join(temp, 'sync-host');
    const guestDot = path.join(temp, 'sync-guest');
    write(path.join(hostDot, 'projects', 'D--Code-my-app', 's1.jsonl'), '{"cwd":"D:\\\\Code\\\\my-app","t":1}\n');
    write(path.join(hostDot, 'projects', 'C--Other', 's2.jsonl'), '{"x":1}\n');
    write(path.join(hostDot, 'todos', 's1.json'), '[]');
    write(path.join(hostDot, 'history.jsonl'), '{"display":"hi","timestamp":1,"project":"D:\\\\Code\\\\my-app"}\n');
    const paths = { hostClaudeDir: hostDot, guestClaudeDir: guestDot, hostWorkspace: hostWs, guestWorkspace: guestWs };
    syncHistoryIn(paths);
    check(fs.readFileSync(path.join(guestDot, 'projects', 'C--Workspace-my-app', 's1.jsonl'), 'utf8').includes('C:\\\\Workspace\\\\my-app') && fs.existsSync(path.join(guestDot, 'projects', 'C--Other', 's2.jsonl')) && fs.existsSync(path.join(guestDot, 'todos', 's1.json')), 'history in: current project renamed + translated, other projects and todos copied');
    check(fs.readFileSync(path.join(guestDot, 'history.jsonl'), 'utf8').includes('C:\\\\Workspace\\\\my-app'), 'prompt history in: project paths translated');
    await sleep(20);
    fs.appendFileSync(path.join(guestDot, 'projects', 'C--Workspace-my-app', 's1.jsonl'), '{"cwd":"C:\\\\Workspace\\\\my-app","t":2}\n{"partial":');
    write(path.join(guestDot, 'projects', 'C--Workspace-my-app', 's3.jsonl'), '{"new":true}\n');
    fs.appendFileSync(path.join(guestDot, 'history.jsonl'), '{"display":"from sandbox","timestamp":2,"project":"C:\\\\Workspace\\\\my-app"}\n');
    write(path.join(guestDot, 'projects', 'C--Workspace-my-app', 'evil.exe'), 'MZ');
    syncHistoryOut(paths);
    const back = fs.readFileSync(path.join(hostDot, 'projects', 'D--Code-my-app', 's1.jsonl'), 'utf8');
    check(back.includes('"t":2') && back.includes('D:\\\\Code\\\\my-app') && !back.includes('partial') && fs.existsSync(path.join(hostDot, 'projects', 'D--Code-my-app', 's3.jsonl')), 'history out: new transcript lines come back translated; half-written lines wait');
    check(!fs.existsSync(path.join(hostDot, 'projects', 'D--Code-my-app', 'evil.exe')), 'history out: only data files come back from the sandbox (no executables)');
    const hist = fs.readFileSync(path.join(hostDot, 'history.jsonl'), 'utf8').trim().split('\n');
    check(hist.length === 2 && hist[1].includes('from sandbox') && hist[1].includes('D:\\\\Code\\\\my-app'), 'prompt history out: only new lines appended, translated back');
    syncHistoryOut(paths);
    check(fs.readFileSync(path.join(hostDot, 'history.jsonl'), 'utf8').trim().split('\n').length === 2, 'syncing again adds nothing (idempotent)');

    const memHost = path.join(temp, 'mem-host');
    const memGuest = path.join(temp, 'mem-guest');
    write(path.join(memHost, 'claude-mem.db'), 'host-v1');
    const memState: SyncState = { hostClaudeDir: hostDot, hostWorkspace: hostWs, guestWorkspace: guestWs };
    check(syncClaudeMem(memHost, memGuest, memState, 'in') === 'copied-in' && fs.readFileSync(path.join(memGuest, 'claude-mem.db'), 'utf8') === 'host-v1', 'claude-mem in: copied into the sandbox store');
    await sleep(30);
    write(path.join(memGuest, 'claude-mem.db'), 'guest-v2');
    check(syncClaudeMem(memHost, memGuest, memState, 'out') === 'copied-out' && fs.readFileSync(path.join(memHost, 'claude-mem.db'), 'utf8') === 'guest-v2', 'claude-mem out: sandbox changes come back');
    check(syncClaudeMem(memHost, memGuest, memState, 'out') === 'unchanged', 'claude-mem: nothing changed, nothing copied');
    await sleep(30);
    write(path.join(memGuest, 'claude-mem.db'), 'guest-v3');
    write(path.join(memHost, 'claude-mem.db'), 'host-v3');
    check(syncClaudeMem(memHost, memGuest, memState, 'out') === 'conflict' && fs.readdirSync(temp).some((f) => f.startsWith('mem-host.conflict-')), 'claude-mem: both sides changed -> the overwritten copy is kept as .conflict-<time>');

    // ---- accounts -------------------------------------------------------------------------------------------------
    const storage = path.join(temp, 'acct-storage');
    const dataA = path.join(storage, 'data', 'x');
    const sandboxClaude = path.join(dataA, 'state', 'claude');
    write(path.join(sandboxClaude, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"personal-1"}}');
    write(path.join(sandboxClaude, '.claude.json'), '{"oauthAccount":{"emailAddress":"me@personal"},"other":1}');
    saveAccount(storage, dataA, 'personal', null);
    write(path.join(temp, 'host-login', '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"work-1"}}');
    write(path.join(temp, 'host-login.json'), '{"oauthAccount":{"emailAddress":"me@work"}}');
    saveAccount(storage, dataA, 'work', { claudeDir: path.join(temp, 'host-login'), globalStateFile: path.join(temp, 'host-login.json') });
    check(listAccounts(storage, dataA).length === 2 && defaultAccount(storage) === 'personal' && activeAccount(dataA) === 'personal', 'accounts: save from sandbox and from this PC; first one becomes default');
    write(path.join(sandboxClaude, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"personal-2"}}');
    activateAccount(storage, dataA, 'work');
    const stateAfter = JSON.parse(fs.readFileSync(path.join(sandboxClaude, '.claude.json'), 'utf8'));
    check(fs.readFileSync(path.join(sandboxClaude, '.credentials.json'), 'utf8').includes('work-1') && stateAfter.oauthAccount.emailAddress === 'me@work' && stateAfter.other === 1 && activeAccount(dataA) === 'work', 'accounts: switching swaps credentials + oauthAccount, keeps other state');
    check(JSON.stringify(readAccount(storage, 'personal')?.credentials).includes('personal-2'), 'accounts: the outgoing account\'s refreshed tokens are saved back before switching');
    setDefaultAccount(storage, 'work');
    removeAccount(storage, 'work');
    check(defaultAccount(storage) === null && await rejects(() => activateAccount(storage, dataA, 'nope'), 'Unknown account') && await rejects(() => saveAccount(storage, dataA, '../x', null), 'Account names'), 'accounts: remove clears the default; bad names and unknown accounts are rejected');

    // ---- cleanup --------------------------------------------------------------------------------------------------
    const store = path.join(temp, 'prune');
    const aged = (p: string, days: number): string => { const t = new Date(Date.now() - days * 86400000); fs.utimesSync(p, t, t); return p; };
    for (const [name, days] of [['old', 9], ['kept', 30], ['new', 1]] as const) aged(write(path.join(store, 'launches', name, 'agent.wsb'), 'x'), days) && aged(path.join(store, 'launches', name), days);
    aged(write(path.join(store, 'data', 'd', 'logs', 'guest-old.log'), 'x'), 20);
    write(path.join(store, 'data', 'd', 'logs', 'guest-new.log'), 'x');
    ensureDir(path.join(store, 'data', 'd', 'tools', 'git.staging-ab12'));
    aged(path.join(store, 'data', 'd', 'tools', 'git.staging-ab12'), 2);
    ensureDir(path.join(store, 'data', 'd', 'tools', 'node'));
    const pruned = pruneStorage(store, { keep: ['kept'] });
    const left = (p: string): boolean => fs.existsSync(path.join(store, p));
    check(pruned.launches === 1 && !left('launches/old') && left('launches/kept') && left('launches/new') && !left('data/d/logs/guest-old.log') && left('data/d/logs/guest-new.log') && !left('data/d/tools/git.staging-ab12') && left('data/d/tools/node'), 'cleanup: launches > 7 days, logs > 14 days and interrupted downloads go; the running launch and real tools stay');
    // ---- channel safety, small helpers ----------------------------------------------------------------------------
    check(await rejects(() => safeId('../evil'), 'Invalid id') && !validRequest({ kind: 'shell', id: 'a' }) && !validRequest({ kind: 'exec', id: 'a/b', command: ['x'], cwd: 'C:\\', timeoutSeconds: 1 }) && validRequest({ kind: 'ping', id: 'abc' }), 'channel: only known request kinds with safe ids are accepted');
    const goodSession = { id: 's1', harness: 'claude', cwd: 'C:\\Workspace', message: 'ok', phase: 'running', startedAt: 'x', attach: { addresses: ['172.20.1.5'], port: 5000, token: 't' } };
    check(validSession(goodSession) && !validSession({ ...goodSession, attach: { ...goodSession.attach, port: 70000 } }) && !validSession({ ...goodSession, phase: 'pwned' }), 'channel: guest session status is shape-checked');
    const ifaces = { 'vEthernet (Default Switch)': [{ address: '172.20.0.1', netmask: '255.255.240.0', family: 'IPv4', internal: false, mac: '', cidr: null }], Ethernet: [{ address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null }] } as unknown as ReturnType<typeof os.networkInterfaces>;
    check(isSandboxAddress('172.20.5.9', ifaces) && !isSandboxAddress('192.168.1.20', ifaces) && !isSandboxAddress('127.0.0.1', ifaces) && !isSandboxAddress('8.8.8.8', ifaces), 'attach only connects to the sandbox\'s Hyper-V subnet (not LAN, loopback or internet)');
    const releases = [{ version: 'v23.1.0', lts: false as const }, { version: 'v22.11.0', lts: 'Jod' }, { version: 'v20.18.0', lts: 'Iron' }, { version: 'v20.9.0', lts: 'Iron' }];
    check(pickNodeVersion(releases, 'lts/*') === '22.11.0' && pickNodeVersion(releases, 'lts/iron') === '20.18.0' && pickNodeVersion(releases, '20') === '20.18.0' && pickNodeVersion(releases, 'v20.9.0') === '20.9.0' && pickNodeVersion(releases, 'node') === '23.1.0' && pickNodeVersion(releases, '99') === null, '.nvmrc specs resolve (lts/*, lts/<name>, major, exact, node)');
    check(pickPackageVersion(['3.9.13', '3.12.7', '3.12.10', '3.13.0-rc1', '3.13.1'], '3') === '3.13.1' && pickPackageVersion(['3.12.7', '3.12.10'], '3.12') === '3.12.10' && pickPackageVersion(['2.7.18'], '2.7') === '2.7.18', 'Python versions resolve to the newest stable match');
    const reg = toRegFile([{ key: 'Control Panel\\Desktop', name: 'WallpaperStyle', kind: 'String', value: '10' }, { key: 'X', name: 'D', kind: 'DWord', value: 4294967295 }, { key: 'X', name: 'B', kind: 'Binary', value: Buffer.from([1, 255]).toString('base64') }]);
    check(reg.includes('[HKEY_CURRENT_USER\\Control Panel\\Desktop]') && reg.includes('"WallpaperStyle"="10"') && reg.includes('"D"=dword:ffffffff') && reg.includes('"B"=hex:01,ff'), 'personalisation: registry values become a valid .reg file');
    const [s172, e172] = cidrToRange('172.16.0.0/12');
    const gw = 172 * 16777216 + 28 * 65536 + 1;
    check(subtractIps([[s172, e172]], ['172.28.0.1']).every(([s, e]) => gw < s || gw > e) && !buildFirewallCommands(['8.8.8.8']).join().includes('8.8.8.8'), 'firewall maths: private block minus the gateway; public addresses ignored');
    check(parseDefaultGateways('  0.0.0.0          0.0.0.0     172.28.80.1   172.28.85.200     5\n').join() === '172.28.80.1' && parseDnsServers('   DNS Servers . . . : 172.28.80.1\n                       8.8.8.8\n   NetBIOS : x\n').join() === '172.28.80.1,8.8.8.8', 'parses gateway and DNS servers');

    // ---- live: ptyhost + guest daemon (Windows only) --------------------------------------------------------------
    if (isWin && fs.existsSync(CSC)) await liveTests(temp, check, genA.launchPath);
    else console.log('SKIP  live ptyhost/daemon tests (need Windows with the .NET Framework compiler)');
  } catch (e) {
    console.log('\x1b[31mFAIL\x1b[0m  unexpected error: ' + errMsg(e) + (e instanceof Error && e.stack ? '\n' + e.stack : ''));
    failures++;
  } finally {
    process.env.WINDIR = originalWindir;
    if (originalHome === undefined) delete process.env.AGENT_SANDBOX_HOME; else process.env.AGENT_SANDBOX_HOME = originalHome;
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
  return failures === 0 ? 0 : 1;
};

type Check = (ok: boolean, name: string) => void;

/** Runs the real guest daemon against a fake "claude" (cmd.exe) and drives it through the run folder like the host does. */
const liveTests = async (temp: string, check: Check, launchPath: string): Promise<void> => {
  const data = path.join(temp, 'live-data');
  const workspace = path.join(temp, 'work-a');
  const agentDir = path.join(data, 'tools', 'agents', 'claude');
  ensureDir(agentDir);
  fs.copyFileSync(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'cmd.exe'), path.join(agentDir, 'claude.exe'));
  const sessionFile = path.join(launchPath, 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  session.workspace = workspace;
  session.harness.arguments = ['/d', '/k', 'echo LIVE-AGENT-READY'];
  session.harness.resumeArguments = ['/d', '/k', 'echo LIVE-AGENT-RESUMED'];
  session.attach.enabled = true;
  fs.writeFileSync(sessionFile, JSON.stringify(session));
  const env = { ...process.env, AGENT_LAUNCH_DIR: launchPath, AGENT_DATA_DIR: data, AGENT_WORKSPACE: workspace, AGENT_LOCAL_DIR: path.join(temp, 'local'), AGENT_LOG_PREFIX: 'daemon', AGENT_NO_TABS: '1' };
  const daemon = spawn(process.execPath, [path.join(launchPath, 'guest', 'daemon.js')], { env, stdio: 'ignore', windowsHide: true });
  const run = path.join(data, 'run');
  const waitFor = async <T>(read: () => T | null, ms = 30000): Promise<T | null> => { const end = Date.now() + ms; while (Date.now() < end) { const v = read(); if (v) return v; await sleep(250); } return null; };
  try {
    writeJsonAtomic(path.join(run, 'requests', 'live1.json'), { kind: 'session', id: 'live1', harness: 'claude', args: [], cwd: workspace, createdAt: new Date().toISOString() });
    const s = await waitFor(() => { const v = readJsonFile<SessionStatus>(path.join(run, 'sessions', 'live1.json')); return v && v.phase !== 'starting' ? v : null; }, 60000);
    check(s?.phase === 'running' && Boolean(s.attach?.port), 'live: daemon compiles ptyhost and starts a session on request' + (s?.phase === 'failed' ? ' (' + s.message + ')' : ''));
    if (!s?.attach) return;
    const socket = await connect({ ...s.attach, addresses: ['127.0.0.1'] });
    const reader = new FrameReader();
    let out = '';
    let exitCode: number | null = null;
    socket.on('data', (c: Buffer) => { for (const f of reader.push(c)) { if (f.type === FrameType.Output) out += f.payload.toString(); if (f.type === FrameType.Exit) exitCode = f.payload.readInt32LE(0); } });
    socket.write(helloFrame(s.attach.token, 100, 30));
    await waitFor(() => out.includes('LIVE-AGENT-READY') || null, 10000);
    check(out.includes('LIVE-AGENT-READY'), 'live: attached client sees the agent\'s screen');
    socket.write(encodeFrame(FrameType.Input, Buffer.from('echo TYPED-%USERNAME:~0,0%OK\r')));
    await waitFor(() => out.includes('TYPED-OK') || null, 10000);
    check(out.includes('TYPED-OK'), 'live: keystrokes reach the agent');

    writeJsonAtomic(path.join(run, 'requests', 'exec1.json'), { kind: 'exec', id: 'exec1', command: ['echo', 'hello from exec'], cwd: workspace, timeoutSeconds: 30, createdAt: new Date().toISOString() });
    const ex = await waitFor(() => readJsonFile<GuestResponse>(path.join(run, 'responses', 'exec1.json')));
    check(Boolean(ex?.ok && ex.stdout?.includes('hello from exec')), 'live: exec runs a command in the sandbox and returns its output');
    writeJsonAtomic(path.join(run, 'requests', 'exec2.json'), { kind: 'exec', id: 'exec2', command: ['dir'], cwd: 'C:\\Windows', timeoutSeconds: 30, createdAt: new Date().toISOString() });
    const ex2 = await waitFor(() => readJsonFile<GuestResponse>(path.join(run, 'responses', 'exec2.json')));
    check(ex2?.ok === false && ex2.message.includes('not inside the sandbox workspace'), 'live: exec refuses folders outside the workspace');
    writeJsonAtomic(path.join(run, 'requests', 'evil.json'), { kind: 'shell', id: 'evil', command: 'calc' });
    writeJsonAtomic(path.join(run, 'requests', 'ping1.json'), { kind: 'ping', id: 'ping1', createdAt: new Date().toISOString() });
    const ping = await waitFor(() => readJsonFile<GuestResponse>(path.join(run, 'responses', 'ping1.json')));
    check(Boolean(ping?.ok) && !fs.existsSync(path.join(run, 'responses', 'evil.json')), 'live: ping answers; unknown request kinds are ignored');

    writeJsonAtomic(path.join(run, 'requests', 'restart1.json'), { kind: 'restart', id: 'restart1', harness: 'claude', createdAt: new Date().toISOString() });
    await waitFor(() => out.includes('LIVE-AGENT-RESUMED') || null, 15000);
    check(out.includes('LIVE-AGENT-RESUMED'), 'live: restart relaunches the agent with its resume arguments while attached');
    socket.write(encodeFrame(FrameType.Input, Buffer.from('exit 3\r')));
    await waitFor(() => exitCode, 10000);
    const ended = await waitFor(() => { const v = readJsonFile<SessionStatus>(path.join(run, 'sessions', 'live1.json')); return v?.phase === 'exited' ? v : null; });
    check(exitCode === 3 && ended?.exitCode === 3, 'live: the agent\'s exit code reaches the client and the session status');
    socket.destroy();
  } finally {
    daemon.kill();
    await sleep(500);
  }
};
