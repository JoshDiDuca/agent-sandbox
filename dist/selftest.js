import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
//TS import type { Config, RunRequest } from './types.js';
import { loadConfig } from './config.js';
import { generateSandbox, resolveMemoryMb } from './sandbox.js';
import { ensureDir, errMsg } from './util.js';
import { resolveRun } from './workspace.js';
import { buildFirewallCommands, cidrToRange, parseDefaultGateways, parseDnsServers, subtractIps } from './guest/netrules.js';

export async function selfTest(projectRoot/*: string*/)/*: Promise<number>*/ {
  let failures = 0;
  const check = (ok/*: boolean*/, name/*: string*/)/*: void*/ => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name); if (!ok) failures++; };
  const rejects = async (fn/*: () => Promise<unknown>*/, needle/*: string*/)/*: Promise<boolean>*/ => { try { await fn(); return false; } catch (e) { return errMsg(e).includes(needle); } };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sandbox-test-'));
  const originalWindir = process.env.WINDIR;
  try {
    const shipped = loadConfig(path.join(projectRoot, 'config.json'));
    check(shipped.config.projects === undefined && shipped.config.guestWorkspace === 'C:\\Workspace' && Array.isArray(shipped.config.mappings), 'shipped config.json loads with no "projects" required');

    const hostNode = path.join(temp, 'host-node');
    ensureDir(path.join(hostNode, 'node_modules', 'npm', 'bin'));
    fs.writeFileSync(path.join(hostNode, 'node.exe'), 'x');
    fs.writeFileSync(path.join(hostNode, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    const hostClaude = path.join(temp, 'host-claude');
    ensureDir(hostClaude);
    fs.writeFileSync(path.join(hostClaude, 'claude.exe'), 'fake-claude');
    const hostProfile = path.join(temp, 'host-dot-claude');
    ensureDir(path.join(hostProfile, 'commands'));
    fs.writeFileSync(path.join(hostProfile, 'settings.json'), '{ "theme": "dark" }');
    fs.writeFileSync(path.join(hostProfile, 'CLAUDE.md'), 'my rules');
    fs.writeFileSync(path.join(hostProfile, 'commands', 'review.md'), 'review cmd');
    fs.writeFileSync(path.join(hostProfile, '.credentials.json'), '{ "token": "secret" }');
    fs.writeFileSync(path.join(hostProfile, 'history.jsonl'), 'private history');
    const hostGlobalState = path.join(temp, 'host-claude.json');
    fs.writeFileSync(hostGlobalState, '{ "hasCompletedOnboarding": true }');

    const install = path.join(temp, 'install');
    ensureDir(path.join(install, 'sub'));
    const workA = path.join(temp, 'work-a');
    const workB = path.join(temp, 'work-b');
    const shared = path.join(temp, 'shared');
    for (const d of [workA, workB, shared, path.join(workB, 'assets')]) ensureDir(d);
    fs.writeFileSync(path.join(workB, 'setup.mjs'), "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.AGENT_DATA, 'hook-ran.txt'), process.env.AGENT_WORKSPACE);\n");

    const makeConfig = (copyFromHost/*: boolean*/, withHostClaude/*: boolean*/)/*: Config*/ => {
      const c = JSON.parse(JSON.stringify(shipped.config))/*as Config*/;
      c.storage.root = path.join(temp, 'storage');
      c.storage.dataName = 'testdata';
      c.sandbox.memoryMb = 8192;
      c.provisioning.copyFromHost = copyFromHost;
      c.provisioning.node.hostDir = hostNode;
      c.provisioning.git.enabled = false;
      c.harnesses.claude.hostDir = withHostClaude ? hostClaude : path.join(temp, 'nowhere');
      c.claudeProfile.hostDir = hostProfile;
      c.claudeProfile.globalStateFile = hostGlobalState;
      c.mappings = [{ host: path.join(temp, 'missing-optional'), guest: 'C:\\GameSources\\Missing', readOnly: true, optional: true }];
      delete c.projects;
      return c;
    };
    const baseConfig = makeConfig(true, true);
    const loadedFor = (config/*: Config*/)/*: RunRequest['loaded']*/ => ({ config, configPath: path.join(temp, 'config.json'), base: temp });
    const run = (over/*: Partial<RunRequest>*/ = {}, config/*: Config*/ = baseConfig)/*: ReturnType<typeof resolveRun>*/ => resolveRun({ projectRoot: install, loaded: loadedFor(config), cwd: workA, noAgent: false, noLocalConfig: false, trustConfig: false, scripts: [], ...over });
    const probe1 = { nodeDir: hostNode, harnessExe: { dir: hostClaude, file: 'claude.exe' } };
    const generate = (r/*: Awaited<ReturnType<typeof resolveRun>>*/, probe = probe1, args/*: string[]*/ = [])/*: ReturnType<typeof generateSandbox>*/ => generateSandbox({ projectRoot, config: r.config, base: temp, dataName: r.dataName, harnessName: r.harnessName, harnessArgs: args, workspaceHost: r.workspaceHost, scripts: r.scripts, probe });
    const writeLocal = (dir/*: string*/, content/*: unknown*/)/*: void*/ => fs.writeFileSync(path.join(dir, '.sandbox-config.json'), typeof content === 'string' ? content : JSON.stringify(content));

    // ---- run from any directory: that folder is the workspace -------------------------------------------------
    const rA = await run();
    check(rA.workspaceHost === workA && rA.localConfigPath === null && rA.dataName === 'testdata' && rA.harnessName === 'claude', 'running from any folder uses that folder as the workspace (no project needed)');
    const genA = generate(rA, { nodeDir: null, harnessExe: null });
    check(genA.mappings.length === 3 && genA.mappings[2].host === workA && genA.mappings[2].guest === 'C:\\Workspace' && genA.mappings[2].readOnly === false, 'only the launch folder, persistent data and the workspace (read/write) are mapped');
    const wsb = fs.readFileSync(generate(rA).wsbPath, 'utf8');
    check(wsb.includes('<MemoryInMB>8192</MemoryInMB>') && wsb.includes('<SandboxFolder>C:\\Workspace</SandboxFolder>') && wsb.includes('C:\\HostTools\\node') && wsb.includes('C:\\HostTools\\agents\\claude') && !wsb.includes('Missing'), 'wsb: memory, workspace, host tools, optional missing mapping skipped');
    check(wsb.includes('<Command>C:\\AgentLaunch\\sandbox\\logon.cmd</Command>'), 'wsb: logon command points at logon.cmd');
    check(await rejects(() => run({ cwd: install }), 'agent-sandbox install folder') && await rejects(() => run({ cwd: path.join(install, 'sub') }), 'agent-sandbox install folder') && await rejects(() => run({ cwd: temp }), 'could modify it') && await rejects(() => run({ cwd: path.join(temp, 'storage') }), 'storage folder'), 'refuses the install folder, its parents and the storage folder as workspace');
    ensureDir(path.join(temp, 'winroot', 'sys'));
    process.env.WINDIR = path.join(temp, 'winroot');
    const sysRefused = await rejects(() => run({ cwd: path.join(temp, 'winroot', 'sys') }), 'system folder');
    if (originalWindir === undefined) delete process.env.WINDIR; else process.env.WINDIR = originalWindir;
    check(sysRefused && await rejects(() => run({ cwd: path.parse(temp).root }), 'drive root'), 'refuses system folders and drive roots');

    // ---- .sandbox-config.json -------------------------------------------------------------------------------------
    const localB = { _comment: 'example', harness: 'codex', sandbox: { memoryMb: 4096, networking: false }, provisioning: { git: { enabled: false } }, mappings: [{ host: './assets', guest: 'C:\\Assets', readOnly: true }, { host: '../shared', guest: 'C:\\Shared', readOnly: false }], scripts: ['./setup.mjs'] };
    writeLocal(workB, localB);
    check(await rejects(() => run({ cwd: workB }), '--trust-config') && await rejects(() => run({ cwd: workB }), 'READ/WRITE'), 'an untrusted .sandbox-config.json is refused (non-interactive) and its effects are listed');
    check(await rejects(() => run({ cwd: workB, ask: async () => false }), 'Untrusted'), 'answering "no" to the trust prompt refuses it');
    const rB = await run({ cwd: workB, ask: async () => true });
    check(rB.localConfigPath === path.join(workB, '.sandbox-config.json') && fs.existsSync(path.join(temp, 'storage', 'trusted-configs.json')), 'answering "yes" applies it and remembers the approval');
    check(rB.harnessName === 'codex' && rB.config.sandbox.memoryMb === 4096 && rB.config.sandbox.networking === false && rB.config.sandbox.vGpu === true && rB.config.provisioning.git.enabled === false && rB.config.provisioning.copyFromHost === true, 'local settings override config.json while everything else keeps the defaults');
    const mapB = rB.config.mappings;
    check(mapB.some((m) => m.host === path.join(workB, 'assets') && m.guest === 'C:\\Assets' && m.readOnly) && mapB.some((m) => m.host === shared && m.guest === 'C:\\Shared' && !m.readOnly) && rB.scripts.includes(path.join(workB, 'setup.mjs')), 'relative mapping/script paths resolve against the folder containing .sandbox-config.json');
    const rB2 = await run({ cwd: workB });
    check(rB2.harnessName === 'codex', 'an already-approved file is used again without asking');
    check((await run({ cwd: workB, noLocalConfig: true })).harnessName === 'claude' && (await run({ cwd: workB, harness: 'gemini' })).harnessName === 'gemini', '--no-local-config ignores the file; --harness beats it');
    writeLocal(workB, { ...localB, sandbox: { memoryMb: 6144 } });
    check(await rejects(() => run({ cwd: workB }), 'Untrusted'), 'changing the file requires approval again');
    check((await run({ cwd: workB, trustConfig: true })).config.sandbox.memoryMb === 6144, '--trust-config approves without asking');
    const dirC = path.join(temp, 'work-c');
    ensureDir(dirC);
    const bad = async (content/*: unknown*/, needle/*: string*/)/*: Promise<boolean>*/ => { writeLocal(dirC, content); return rejects(() => run({ cwd: dirC, trustConfig: true }), needle); };
    check(await bad({ storage: { root: 'C:\\x' } }, 'storage is not an allowed'), 'local file cannot change storage');
    check(await bad({ harnesses: { evil: { hostExecutable: 'x.exe' } } }, 'harnesses is not an allowed'), 'local file cannot define agent executables');
    check(await bad({ claudeProfile: { hostDir: 'C:\\Users\\x' } }, 'claudeProfile.hostDir is not allowed'), 'local file cannot point Claude settings at other host folders');
    check(await bad({ provisioning: { node: { hostDir: 'C:\\x' } } }, 'provisioning.node.hostDir is not allowed'), 'local file cannot choose host Node folders');
    check(await bad({ readOnly: 'yes' }, 'readOnly must be true or false') && await bad({ sandbox: { memoryMb: 12 } }, 'sandbox.memoryMb has the wrong'), 'local file values are type-checked');
    check(await bad({ mappings: [{ host: 'x', guest: 'C:\\Windows\\x', readOnly: true }] }, 'Invalid or reserved guest path') && await bad({ workspace: 'C:\\x' }, 'only allowed in config.json project presets'), 'reserved guest paths and a "workspace" override are rejected');
    check(await bad('{ nope', 'not valid JSON') && await bad({ scripts: ['./missing.ps1'] }, 'file not found'), 'invalid JSON and missing scripts give clear errors');
    writeLocal(dirC, { claudeProfile: { copyCredentials: true }, mappings: [{ host: '.', guest: 'C:\\Rw', readOnly: false }] });
    check(await rejects(() => run({ cwd: dirC }), 'copies your Claude LOGIN') && await rejects(() => run({ cwd: dirC }), 'READ/WRITE mapping'), 'risky settings are called out before you approve them');
    fs.rmSync(path.join(dirC, '.sandbox-config.json'));

    // ---- defaults in config.json, presets, read-only workspaces ------------------------------------------------------
    const withDefaults = makeConfig(true, true);
    withDefaults.mappings = [{ host: shared, guest: 'C:\\Common', readOnly: true, optional: false }];
    const rD = await run({}, withDefaults);
    check(generate(rD).mappings.some((m) => m.host === shared && m.guest === 'C:\\Common' && m.readOnly), 'mappings in config.json apply to every run');
    const withPreset = makeConfig(true, true);
    withPreset.projects = { legacy: { workspace: path.join(temp, 'preset-ws'), createWorkspace: true, guestWorkspace: 'C:\\Legacy', readOnly: true, mappings: [{ host: shared, guest: 'C:\\LegacyShared', readOnly: true }] } };
    const rP = await run({ project: 'legacy' }, withPreset);
    check(rP.workspaceHost === path.join(temp, 'preset-ws') && fs.existsSync(rP.workspaceHost) && rP.config.guestWorkspace === 'C:\\Legacy' && rP.config.readOnly === true && rP.dataName === 'legacy', '--project presets still work (workspace, guest path, read-only, own data folder)');
    check((await run({ project: 'legacy', workspace: workA }, withPreset)).workspaceHost === workA && await rejects(() => run({ project: 'nope' }, withPreset), 'Unknown project preset'), '--workspace beats a preset; unknown presets are rejected');
    const wsbRo = fs.readFileSync(generate(rP).wsbPath, 'utf8');
    check(wsbRo.includes('<SandboxFolder>C:\\Legacy</SandboxFolder><ReadOnly>true</ReadOnly>'), 'read-only workspace is written into the sandbox config');

    // ---- generated files, hooks, claude settings, guest runner ----------------------------------------------------------
    const gen = generate(await run({ cwd: workB, scripts: [] }), probe1, ['--version']);
    const session = JSON.parse(fs.readFileSync(gen.sessionPath, 'utf8'));
    check(session.workspace === 'C:\\Workspace' && session.project === 'work-b' && session.harnessArguments[0] === '--version' && session.harnessName === 'codex', 'session.json: workspace, project name, harness, arguments');
    check(['guest/main.js', 'guest/netrules.js', 'guest/package.json', 'sandbox/bootstrap.ps1', 'sandbox/logon.cmd'].every((f) => fs.existsSync(path.join(gen.launchPath, f))) && fs.readdirSync(path.join(gen.launchPath, 'hooks', 'pre-agent')).some((f) => f.includes('setup.mjs')), 'launch folder has the guest runner, bootstrap, logon.cmd and the local script as a pre-agent hook');
    const logonCmd = fs.readFileSync(path.join(gen.launchPath, 'sandbox', 'logon.cmd'), 'utf8');
    check(logonCmd.includes('logon-hit.txt') && logonCmd.includes('start "Agent Sandbox" powershell.exe') && logonCmd.includes('-NoExit') && logonCmd.includes('bootstrap.ps1'), 'logon.cmd writes a marker and opens a visible PowerShell for bootstrap.ps1');

    const rClaude = await run();
    const genC = generate(rClaude, probe1, ['--version']);
    const staged = path.join(genC.launchPath, 'claude-profile');
    check(['settings.json', 'CLAUDE.md', '.claude.json'].every((f) => fs.existsSync(path.join(staged, f))) && fs.existsSync(path.join(staged, 'commands', 'review.md')) && !fs.existsSync(path.join(staged, '.credentials.json')) && !fs.existsSync(path.join(staged, 'history.jsonl')), 'claude settings staged; login and history are not');

    const runGuest = (launchPath/*: string*/, hostTools/*: string*/, data/*: string*/, workspace/*: string*/, extraEnv/*: Record<string, string>*/ = {})/*: { status: number | null; out: string }*/ => {
      const r = spawnSync(process.execPath, [path.join(launchPath, 'guest', 'main.js')], { encoding: 'utf8', env: { ...process.env, AGENT_LAUNCH_DIR: launchPath, AGENT_DATA_DIR: data, AGENT_HOST_TOOLS_DIR: hostTools, AGENT_WORKSPACE: workspace, AGENT_DRY_RUN: '1', ...extraEnv } });
      return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
    };
    const hostTools = path.join(temp, 'host-tools');
    ensureDir(path.join(hostTools, 'agents', 'claude'));
    fs.copyFileSync(path.join(hostClaude, 'claude.exe'), path.join(hostTools, 'agents', 'claude', 'claude.exe'));
    const data1 = path.join(temp, 'data1');
    const r1 = runGuest(genC.launchPath, hostTools, data1, workA, { AGENT_TEST_EXEMPT: '172.28.0.1' });
    check(r1.status === 0 && r1.out.includes('would run:') && r1.out.includes('--version') && r1.out.includes('cwd=' + workA), 'guest (copy mode) starts claude with its arguments in the workspace' + (r1.status === 0 ? '' : '\n' + r1.out));
    check(fs.existsSync(path.join(data1, 'tools', 'agents', 'claude', 'claude.exe')), 'guest copy mode: claude.exe copied into persistent tools');
    const claudeState = path.join(data1, 'state', 'claude');
    check(fs.readFileSync(path.join(claudeState, 'settings.json'), 'utf8').includes('dark') && fs.readFileSync(path.join(claudeState, 'CLAUDE.md'), 'utf8') === 'my rules' && fs.existsSync(path.join(claudeState, 'commands', 'review.md')) && fs.existsSync(path.join(claudeState, '.claude.json')) && !fs.existsSync(path.join(claudeState, '.credentials.json')), 'guest applied host claude settings (no login)');
    check(r1.out.includes('netsh advfirewall firewall add rule name=AgentSandbox-Block-Private') && r1.out.includes('remoteport=1-52,54-65535'), 'guest network plan uses netsh and keeps DNS to the gateway');
    fs.writeFileSync(path.join(claudeState, '.claude.json'), '{ "guest": true }');
    fs.writeFileSync(path.join(claudeState, 'settings.json'), '{ "edited": true }');
    const r1b = runGuest(genC.launchPath, hostTools, data1, workA);
    check(r1b.out.includes('already cached') && fs.readFileSync(path.join(claudeState, '.claude.json'), 'utf8').includes('guest') && fs.readFileSync(path.join(claudeState, 'settings.json'), 'utf8').includes('dark'), 'second run reuses the cache; host settings refresh, sandbox .claude.json is kept');

    const genHook = generate(await run({ cwd: workB, harness: 'claude', noLocalConfig: false }), probe1);
    const rHook = runGuest(genHook.launchPath, hostTools, path.join(temp, 'data-hook'), workB);
    check(rHook.status === 0 && fs.existsSync(path.join(temp, 'data-hook', 'hook-ran.txt')) && fs.readFileSync(path.join(temp, 'data-hook', 'hook-ran.txt'), 'utf8') === workB, 'local "scripts" run inside the sandbox with the workspace set');

    const credConfig = makeConfig(true, true);
    credConfig.claudeProfile.copyCredentials = true;
    const genCred = generate(await run({}, credConfig));
    const rc = runGuest(genCred.launchPath, hostTools, path.join(temp, 'data-cred'), workA);
    check(genCred.profile.credentials === true && fs.existsSync(path.join(temp, 'data-cred', 'state', 'claude', '.credentials.json')) && rc.out.includes('LOGIN was copied'), 'copyCredentials:true (opt-in) copies the login with a warning');
    const badProfile = path.join(temp, 'bad-dot-claude');
    ensureDir(badProfile);
    fs.writeFileSync(path.join(badProfile, 'settings.json'), '{ not json');
    const badConfig = makeConfig(true, true);
    badConfig.claudeProfile.hostDir = badProfile;
    badConfig.claudeProfile.globalStateFile = '';
    const genBad = generate(await run({}, badConfig));
    check(!genBad.profile.staged.includes('settings.json') && genBad.profile.skipped.some((x) => x.includes('invalid JSON')), 'malformed host settings.json is skipped, not copied');

    const config2 = makeConfig(true, false);
    const r2 = runGuest(generate(await run({}, config2), { nodeDir: hostNode, harnessExe: null }).launchPath, path.join(temp, 'empty-tools'), path.join(temp, 'data2'), workA);
    check(r2.status === 0 && r2.out.includes('installing instead') && r2.out.includes('npm-cli.js') && r2.out.includes('@anthropic-ai/claude-code'), 'copy mode falls back to npm install when host claude is missing');
    const config3 = makeConfig(false, false);
    const gen3 = generate(await run({}, config3), { nodeDir: null, harnessExe: null });
    const r3 = runGuest(gen3.launchPath, path.join(temp, 'empty-tools'), path.join(temp, 'data3'), workA);
    check(!fs.readFileSync(gen3.wsbPath, 'utf8').includes('HostTools') && r3.status === 0 && r3.out.includes('install inside sandbox') && r3.out.includes('npm-cli.js'), 'install mode: no host mappings, installs inside the sandbox');
    const config4 = makeConfig(false, false);
    config4.provisioning.copyFromHost = true;
    config4.provisioning.fallbackToInstall = false;
    const r4 = runGuest(generate(await run({}, config4), { nodeDir: null, harnessExe: null }).launchPath, path.join(temp, 'empty-tools'), path.join(temp, 'data4'), workA);
    check(r4.status === 1 && r4.out.includes('fallbackToInstall is false'), 'no-fallback mode fails loudly when the host copy is missing');
    const r5 = runGuest(generate(await run({ noAgent: true })).launchPath, hostTools, path.join(temp, 'data5'), workA);
    check(r5.status === 0 && r5.out.includes('No agent requested'), '--no-agent provisions and returns to a shell');

    const autoConfig = makeConfig(true, true);
    autoConfig.sandbox.memoryMb = 'auto';
    const mem = (free/*: number*/)/*: number*/ => resolveMemoryMb({ projectRoot, config: autoConfig, base: temp, dataName: 'x', harnessName: 'claude', harnessArgs: [], workspaceHost: workA, scripts: [], probe: probe1, freeMemoryBytes: free * 1048576 });
    check(mem(40000) === 31744 && mem(20000) === 11264, "memory 'auto' follows free RAM minus reserve, capped at max");
    let threw = false;
    try { mem(9000); } catch { threw = true; }
    check(threw, "memory 'auto' refuses when there is not enough free RAM");

    // ---- network rules ---------------------------------------------------------------------------------------------------
    const [s172, e172] = cidrToRange('172.16.0.0/12');
    const pieces = subtractIps([[s172, e172]], ['172.28.0.1']);
    const gw = 172 * 16777216 + 28 * 65536 + 1;
    check(pieces.reduce((n, [s, e]) => n + (e - s + 1), 0) === e172 - s172 && pieces.every(([s, e]) => gw < s || gw > e), 'range maths: private block minus the gateway leaves everything else blocked');
    const cmds = buildFirewallCommands(['172.28.0.1', '8.8.8.8', 'not-an-ip']).map((c) => c.join(' '));
    check(cmds.some((c) => c.includes('add rule name=AgentSandbox-Block-Private') && !c.includes('172.28.0.1') && c.includes('10.0.0.0-')) && cmds.some((c) => c.includes('AgentSandbox-Gateway-TCP') && c.includes('remoteip=172.28.0.1 ') && c.includes('remoteport=1-52,54-65535')) && !cmds.join('\n').includes('8.8.8.8'), 'firewall plan: gateway exempt for DNS/DHCP only, public/invalid addresses ignored');
    check(parseDefaultGateways('  0.0.0.0          0.0.0.0     172.28.80.1   172.28.85.200     5\n  127.0.0.0        255.0.0.0         On-link\n').join() === '172.28.80.1' && parseDnsServers('   DNS Servers . . . . . . . . . . . : 172.28.80.1\n                                       8.8.8.8\n   NetBIOS over Tcpip. . . . . . . . : Enabled\n').join() === '172.28.80.1,8.8.8.8', 'parses gateway and DNS servers from route print / ipconfig');
  } catch (e) {
    console.log('FAIL  unexpected error: ' + errMsg(e) + (e instanceof Error && e.stack ? '\n' + e.stack : ''));
    failures++;
  } finally {
    if (originalWindir === undefined) delete process.env.WINDIR; else process.env.WINDIR = originalWindir;
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nALL TESTS PASSED (offline logic only; live Windows Sandbox must be tested on your PC).' : '\n' + failures + ' TEST(S) FAILED');
  return failures === 0 ? 0 : 1;
}
