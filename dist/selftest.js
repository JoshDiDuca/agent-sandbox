import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
//TS import type { Config } from './types.js';
import { loadConfig } from './config.js';
import { generateSandbox, resolveMemoryMb } from './sandbox.js';
import { ensureDir, errMsg } from './util.js';
import { buildFirewallCommands, cidrToRange, parseDefaultGateways, parseDnsServers, subtractIps } from './guest/netrules.js';

export function selfTest(projectRoot/*: string*/)/*: number*/ {
  let failures = 0;
  const check = (ok/*: boolean*/, name/*: string*/)/*: void*/ => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name); if (!ok) failures++; };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sandbox-test-'));
  try {
    const shipped = loadConfig(path.join(projectRoot, 'config.json'));
    check(shipped.config.projects[shipped.config.defaultProject] !== undefined, 'shipped config.json loads and validates');

    const hostNode = path.join(temp, 'host-node');
    ensureDir(path.join(hostNode, 'node_modules', 'npm', 'bin'));
    fs.writeFileSync(path.join(hostNode, 'node.exe'), 'x');
    fs.writeFileSync(path.join(hostNode, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    const hostClaude = path.join(temp, 'host-claude');
    ensureDir(hostClaude);
    fs.writeFileSync(path.join(hostClaude, 'claude.exe'), 'fake-claude');
    const workspace = path.join(temp, 'workspace');
    ensureDir(workspace);
    const hookScript = path.join(temp, 'hook.mjs');
    fs.writeFileSync(hookScript, "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.AGENT_DATA, 'hook-ran.txt'), process.env.AGENT_WORKSPACE);\n");

    const hostProfile = path.join(temp, 'host-dot-claude');
    ensureDir(path.join(hostProfile, 'commands'));
    fs.writeFileSync(path.join(hostProfile, 'settings.json'), '{ "theme": "dark" }');
    fs.writeFileSync(path.join(hostProfile, 'CLAUDE.md'), 'my rules');
    fs.writeFileSync(path.join(hostProfile, 'commands', 'review.md'), 'review cmd');
    fs.writeFileSync(path.join(hostProfile, '.credentials.json'), '{ "token": "secret" }');
    fs.writeFileSync(path.join(hostProfile, 'history.jsonl'), 'private history');
    const hostGlobalState = path.join(temp, 'host-claude.json');
    fs.writeFileSync(hostGlobalState, '{ "hasCompletedOnboarding": true }');

    const makeConfig = (copyFromHost/*: boolean*/, withHostClaude/*: boolean*/)/*: Config*/ => {
      const c = JSON.parse(JSON.stringify(shipped.config))/*as Config*/;
      c.storage.root = path.join(temp, 'storage');
      c.sandbox.memoryMb = 8192;
      c.provisioning.copyFromHost = copyFromHost;
      c.provisioning.node.hostDir = hostNode;
      c.provisioning.git.enabled = false;
      c.harnesses.claude.hostDir = withHostClaude ? hostClaude : path.join(temp, 'nowhere');
      c.claudeProfile.hostDir = hostProfile;
      c.claudeProfile.globalStateFile = hostGlobalState;
      c.projects[c.defaultProject].mappings = [{ host: path.join(temp, 'missing-optional'), guest: 'C:\\GameSources\\Missing', readOnly: true, optional: true }];
      return c;
    };

    const probe1 = { nodeDir: hostNode, harnessExe: { dir: hostClaude, file: 'claude.exe' } };
    const config1 = makeConfig(true, true);
    const gen = generateSandbox({ projectRoot, config: config1, base: temp, projectName: config1.defaultProject, harnessName: 'claude', harnessArgs: ['--version'], workspaceOverride: workspace, scripts: [hookScript], probe: probe1 });
    const wsb = fs.readFileSync(gen.wsbPath, 'utf8');
    check(wsb.includes('<MemoryInMB>8192</MemoryInMB>'), 'wsb: memory');
    check(wsb.includes('<SandboxFolder>C:\\Workspace</SandboxFolder>'), 'wsb: workspace mapped to C:\\Workspace');
    check(wsb.includes('C:\\HostTools\\node') && wsb.includes('C:\\HostTools\\agents\\claude'), 'wsb: host node + claude mapped read-only');
    check(!wsb.includes('Missing'), 'wsb: missing optional mapping skipped');
    check(wsb.includes('<Command>C:\\AgentLaunch\\sandbox\\logon.cmd</Command>'), 'wsb: logon command points at logon.cmd');
    const logonCmd = fs.readFileSync(path.join(gen.launchPath, 'sandbox', 'logon.cmd'), 'utf8');
    check(logonCmd.includes('logon-hit.txt') && logonCmd.includes('start "Agent Sandbox" powershell.exe') && logonCmd.includes('-NoExit') && logonCmd.includes('bootstrap.ps1'), 'logon.cmd writes a marker and opens a visible PowerShell for bootstrap.ps1');
    const session = JSON.parse(fs.readFileSync(gen.sessionPath, 'utf8'));
    check(session.workspace === 'C:\\Workspace' && session.harnessName === 'claude' && session.harnessArguments[0] === '--version', 'session.json: workspace, harness, arguments');
    check(session.hostTools.node === true && session.hostTools.harnessExecutable === 'claude.exe', 'session.json: host tool flags');
    const launched = ['guest/main.js', 'guest/netrules.js', 'guest/package.json', 'sandbox/bootstrap.ps1', 'sandbox/logon.cmd'].every((f) => fs.existsSync(path.join(gen.launchPath, f)));
    check(launched && fs.readdirSync(path.join(gen.launchPath, 'hooks', 'pre-agent')).some((f) => f.includes('hook.mjs')), 'launch folder contains guest runner, netrules, bootstrap, logon.cmd, hooks and --script copy');

    const staged = path.join(gen.launchPath, 'claude-profile');
    check(['settings.json', 'CLAUDE.md', '.claude.json'].every((f) => fs.existsSync(path.join(staged, f))) && fs.existsSync(path.join(staged, 'commands', 'review.md')), 'claude settings staged: settings.json, CLAUDE.md, commands/, .claude.json');
    check(!fs.existsSync(path.join(staged, '.credentials.json')) && !fs.existsSync(path.join(staged, 'history.jsonl')) && gen.profile.credentials === false, 'login and history are NOT staged by default');
    check(JSON.stringify(session.claudeProfile.items).includes('settings.json') && !JSON.stringify(session.claudeProfile.items).includes('credentials'), 'session.json lists staged claude items');

    const runGuest = (launchPath/*: string*/, hostTools/*: string*/, data/*: string*/, extraEnv/*: Record<string, string>*/ = {})/*: { status: number | null; out: string }*/ => {
      const r = spawnSync(process.execPath, [path.join(launchPath, 'guest', 'main.js')], { encoding: 'utf8', env: { ...process.env, AGENT_LAUNCH_DIR: launchPath, AGENT_DATA_DIR: data, AGENT_HOST_TOOLS_DIR: hostTools, AGENT_WORKSPACE: workspace, AGENT_DRY_RUN: '1', ...extraEnv } });
      return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
    };

    const hostTools = path.join(temp, 'host-tools');
    ensureDir(path.join(hostTools, 'agents', 'claude'));
    fs.copyFileSync(path.join(hostClaude, 'claude.exe'), path.join(hostTools, 'agents', 'claude', 'claude.exe'));
    const data1 = path.join(temp, 'data1');
    const r1 = runGuest(gen.launchPath, hostTools, data1, { AGENT_TEST_EXEMPT: '172.28.0.1' });
    check(r1.status === 0, 'guest (copy mode) exits 0' + (r1.status === 0 ? '' : '\n' + r1.out));
    check(fs.existsSync(path.join(data1, 'tools', 'agents', 'claude', 'claude.exe')), 'guest copy mode: claude.exe copied into persistent tools');
    check(r1.out.includes('would run:') && r1.out.includes('--version') && r1.out.includes('cwd=' + workspace), 'guest starts claude with args in the workspace');
    check(fs.existsSync(path.join(data1, 'hook-ran.txt')) && fs.readFileSync(path.join(data1, 'hook-ran.txt'), 'utf8') === workspace, 'guest ran the --script hook with workspace env');
    const claudeState = path.join(data1, 'state', 'claude');
    check(fs.readFileSync(path.join(claudeState, 'settings.json'), 'utf8').includes('dark') && fs.readFileSync(path.join(claudeState, 'CLAUDE.md'), 'utf8') === 'my rules' && fs.existsSync(path.join(claudeState, 'commands', 'review.md')) && fs.existsSync(path.join(claudeState, '.claude.json')), 'guest applied the host claude settings into CLAUDE_CONFIG_DIR');
    check(!fs.existsSync(path.join(claudeState, '.credentials.json')), 'guest has no login copied by default');
    check(r1.out.includes('netsh advfirewall firewall add rule name=AgentSandbox-Block-Private') && r1.out.includes('remoteport=1-52,54-65535'), 'guest network plan uses netsh (no CIM cmdlets) and keeps DNS to the gateway');
    fs.writeFileSync(path.join(claudeState, '.claude.json'), '{ "guest": true }');
    fs.writeFileSync(path.join(claudeState, 'settings.json'), '{ "edited": true }');
    const r1b = runGuest(gen.launchPath, hostTools, data1);
    check(r1b.out.includes('already cached'), 'second run reuses persistent cache (no re-copy)');
    check(fs.readFileSync(path.join(claudeState, '.claude.json'), 'utf8').includes('guest') && fs.readFileSync(path.join(claudeState, 'settings.json'), 'utf8').includes('dark'), 'settings refresh from host each launch, but the sandbox .claude.json is never overwritten');

    const credConfig = makeConfig(true, true);
    credConfig.claudeProfile.copyCredentials = true;
    const genCred = generateSandbox({ projectRoot, config: credConfig, base: temp, projectName: credConfig.defaultProject, harnessName: 'claude', harnessArgs: [], workspaceOverride: workspace, scripts: [], probe: probe1 });
    check(genCred.profile.credentials === true && fs.existsSync(path.join(genCred.launchPath, 'claude-profile', '.credentials.json')), 'copyCredentials:true stages the login (opt-in)');
    const dataCred = path.join(temp, 'data-cred');
    const rc = runGuest(genCred.launchPath, hostTools, dataCred);
    check(fs.existsSync(path.join(dataCred, 'state', 'claude', '.credentials.json')) && rc.out.includes('LOGIN was copied'), 'guest copies the login only when opted in, with a warning');

    const badProfile = path.join(temp, 'bad-dot-claude');
    ensureDir(badProfile);
    fs.writeFileSync(path.join(badProfile, 'settings.json'), '{ not json');
    const badConfig = makeConfig(true, true);
    badConfig.claudeProfile.hostDir = badProfile;
    badConfig.claudeProfile.globalStateFile = '';
    const genBad = generateSandbox({ projectRoot, config: badConfig, base: temp, projectName: badConfig.defaultProject, harnessName: 'claude', harnessArgs: [], workspaceOverride: workspace, scripts: [], probe: probe1 });
    check(!genBad.profile.staged.includes('settings.json') && genBad.profile.skipped.some((s) => s.includes('invalid JSON')), 'malformed host settings.json is skipped instead of copied');

    const config2 = makeConfig(true, false);
    const gen2 = generateSandbox({ projectRoot, config: config2, base: temp, projectName: config2.defaultProject, harnessName: 'claude', harnessArgs: [], workspaceOverride: workspace, scripts: [], probe: { nodeDir: hostNode, harnessExe: null } });
    const r2 = runGuest(gen2.launchPath, path.join(temp, 'empty-tools'), path.join(temp, 'data2'));
    check(r2.status === 0 && r2.out.includes('installing instead') && r2.out.includes('npm-cli.js') && r2.out.includes('@anthropic-ai/claude-code'), 'copy mode falls back to npm install when host claude is missing');

    const config3 = makeConfig(false, false);
    const gen3 = generateSandbox({ projectRoot, config: config3, base: temp, projectName: config3.defaultProject, harnessName: 'claude', harnessArgs: [], workspaceOverride: workspace, scripts: [], probe: { nodeDir: null, harnessExe: null } });
    const r3 = runGuest(gen3.launchPath, path.join(temp, 'empty-tools'), path.join(temp, 'data3'));
    check(!fs.readFileSync(gen3.wsbPath, 'utf8').includes('HostTools') && r3.status === 0 && r3.out.includes('install inside sandbox') && r3.out.includes('npm-cli.js'), 'install mode: no host mappings, installs inside the sandbox');

    const config4 = makeConfig(false, false);
    config4.provisioning.copyFromHost = true;
    config4.provisioning.fallbackToInstall = false;
    const gen4 = generateSandbox({ projectRoot, config: config4, base: temp, projectName: config4.defaultProject, harnessName: 'claude', harnessArgs: [], workspaceOverride: workspace, scripts: [], probe: { nodeDir: null, harnessExe: null } });
    const r4 = runGuest(gen4.launchPath, path.join(temp, 'empty-tools'), path.join(temp, 'data4'));
    check(r4.status === 1 && r4.out.includes('fallbackToInstall is false'), 'no-fallback mode fails loudly when host copy is missing');

    const gen5 = generateSandbox({ projectRoot, config: config1, base: temp, projectName: config1.defaultProject, harnessName: 'none', harnessArgs: [], workspaceOverride: workspace, scripts: [], probe: probe1 });
    const r5 = runGuest(gen5.launchPath, hostTools, path.join(temp, 'data5'));
    check(r5.status === 0 && r5.out.includes('No agent requested'), '--no-agent provisions and returns to a shell');

    const autoConfig = makeConfig(true, true);
    autoConfig.sandbox.memoryMb = 'auto';
    autoConfig.sandbox.maxMemoryMb = 32768;
    autoConfig.sandbox.reserveHostMb = 8192;
    const mem = (free/*: number*/)/*: number*/ => resolveMemoryMb({ projectRoot, config: autoConfig, base: temp, projectName: 'x', harnessName: 'claude', harnessArgs: [], scripts: [], probe: probe1, freeMemoryBytes: free * 1048576 });
    check(mem(40000) === 31744 && mem(20000) === 11264, "memory 'auto' follows free RAM minus reserve, capped at max");
    let threw = false;
    try { mem(9000); } catch { threw = true; }
    check(threw, "memory 'auto' refuses when there is not enough free RAM");
    let rootRefused = false;
    try { generateSandbox({ projectRoot, config: config1, base: temp, projectName: config1.defaultProject, harnessName: 'claude', harnessArgs: [], workspaceOverride: path.parse(temp).root, scripts: [], probe: probe1 }); } catch { rootRefused = true; }
    check(rootRefused, 'refuses a drive root as the workspace');

    const [s172, e172] = cidrToRange('172.16.0.0/12');
    const pieces = subtractIps([[s172, e172]], ['172.28.0.1']);
    const covered = pieces.reduce((n, [s, e]) => n + (e - s + 1), 0);
    const gw = 172 * 16777216 + 28 * 65536 + 1;
    check(covered === e172 - s172 && pieces.every(([s, e]) => gw < s || gw > e), 'range maths: private block minus the gateway leaves everything else blocked');
    const cmds = buildFirewallCommands(['172.28.0.1', '8.8.8.8', 'not-an-ip']).map((c) => c.join(' '));
    check(cmds.some((c) => c.includes('add rule name=AgentSandbox-Block-Private') && !c.includes('172.28.0.1') && c.includes('10.0.0.0-')) && cmds.some((c) => c.includes('AgentSandbox-Gateway-TCP') && c.includes('remoteip=172.28.0.1 ') && c.includes('remoteport=1-52,54-65535')) && !cmds.join('\n').includes('8.8.8.8'), 'firewall plan: gateway exempt for DNS/DHCP only, public/invalid addresses ignored');
    check(parseDefaultGateways('  0.0.0.0          0.0.0.0     172.28.80.1   172.28.85.200     5\n  127.0.0.0        255.0.0.0         On-link\n').join() === '172.28.80.1', 'parses the default gateway from route print');
    check(parseDnsServers('   DNS Servers . . . . . . . . . . . : 172.28.80.1\n                                       8.8.8.8\n   NetBIOS over Tcpip. . . . . . . . : Enabled\n').join() === '172.28.80.1,8.8.8.8', 'parses DNS servers from ipconfig /all');
  } catch (e) {
    console.log('FAIL  unexpected error: ' + errMsg(e));
    failures++;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nALL TESTS PASSED (offline logic only; live Windows Sandbox must be tested on your PC).' : '\n' + failures + ' TEST(S) FAILED');
  return failures === 0 ? 0 : 1;
}
