// Generated sandbox (.wsb + launch folder) and the guest boot in dry-run mode.
import fs from 'node:fs';
import path from 'node:path';
import { buildWsb, gitIdentity, resolveMemoryMb } from '../host/generate.js';
import { readJsonFile } from '../shared/rundir.js';
import type { Fixtures } from './fixtures.js';
import type { Harness } from './harness.js';

export const guestTests = async (t: Harness, f: Fixtures): Promise<string> => {
  const { check, rejects, at } = { ...t, at: f.at };

  t.section('generated sandbox');
  const rA = await f.run();
  const gen = f.generate(rA, ['--version'], { ...f.probe, gitDir: f.shared, nvmDir: f.workB });
  const wsb = fs.readFileSync(gen.wsbPath, 'utf8');
  check(wsb.includes('<MemoryInMB>8192</MemoryInMB>') && wsb.includes('<SandboxFolder>C:\\Workspace\\work-a</SandboxFolder>') && wsb.includes('C:\\HostTools\\git') && wsb.includes('C:\\HostTools\\nvm') && !wsb.includes('Missing') && wsb.includes('logon.cmd</Command>') && wsb.includes('<vGPU>Disable</vGPU>'), 'wsb: memory, workspace, host git/nvm, optional mapping skipped, logon command, vGPU off');
  const files = ['package.json', 'runtime/main.js', 'runtime/daemon.js', 'runtime/view.js', 'runtime/gitguard.js', 'sandbox/bootstrap.ps1', 'sandbox/logon.cmd', 'sandbox/trust.cmd', 'sandbox/ptyhost.cs', 'sandbox/gitshim.cs'];
  const missing = files.filter((file) => !fs.existsSync(path.join(gen.launchPath, file)));
  check(missing.length === 0 && fs.readdirSync(path.join(gen.launchPath, 'runtime')).length === 4, 'launch folder has the bundled sandbox runtime (4 self-contained files), the C# sources and the boot scripts' + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''));
  const logon = fs.readFileSync(path.join(gen.launchPath, 'sandbox', 'logon.cmd'), 'utf8');
  check(logon.indexOf('trust.cmd') < logon.indexOf('wt.exe') && logon.includes('tools\\terminal\\wt.exe') && logon.includes('-NoExit'), 'logon.cmd applies sandbox trust settings first, then opens Windows Terminal (PowerShell fallback)');
  const session = f.readJson(gen.sessionPath);
  check(session.launchId === gen.launchId && session.workspace === 'C:\\Workspace\\work-a' && session.workspaceHost === f.workA && session.harnessArguments[0] === '--version' && session.hostTools.git && session.hostTools.nvm && /^\d+\.\d+\.\d+$/.test(session.hostTools.nodeVersion ?? '') &&session.versions.node.spec === '22.3.0' && session.provisioning.git.access === 'full', 'session.json carries ids, paths, versions, host tools and git access');
  const staged = path.join(gen.launchPath, 'claude-profile');
  check(['settings.json', 'CLAUDE.md', '.claude.json', 'plugins'].every((file) => fs.existsSync(path.join(staged, file))) && !fs.existsSync(path.join(staged, '.credentials.json')), 'Claude settings and plugins staged; the login is not');
  check(gitIdentity('[user]\n\tname = Josh\n\temail = "j@x.io"\n[credential]\n\thelper = store\n[url "https://TOKEN@github.com/"]\n\tinsteadOf = https://github.com/\n') === '[user]\n\tname = Josh\n\temail = j@x.io\n' && gitIdentity('[core]\n\tname = x\n') === '', 'only name/email from ~/.gitconfig reach the sandbox (no credential helpers or token URLs)');
  check(buildWsb(f.baseConfig, 4096, [{ host: 'C:\\a&b', guest: 'C:\\X', readOnly: true }]).includes('C:\\a&amp;b'), 'wsb values are XML-escaped');
  check(resolveMemoryMb({ ...f.baseConfig.sandbox, memoryMb: 'auto' }, 40000 * 1048576) === 31744 && await rejects(() => resolveMemoryMb({ ...f.baseConfig.sandbox, memoryMb: 'auto' }, 9000 * 1048576), 'Not enough free RAM'), "memory 'auto' follows free RAM minus reserve");

  t.section('guest boot (dry run)');
  const data1 = at('data1');
  const r1 = f.runGuest(gen.launchPath, data1, f.workA, { AGENT_TEST_EXEMPT: '172.28.0.1' });
  check(r1.status === 0 && r1.out.includes('would run:') && r1.out.includes('--version') && r1.out.includes('cwd=' + f.workA), 'guest starts the agent with its arguments in the workspace' + (r1.status === 0 ? '' : '\n' + r1.out));
  check(['would provision nvm and Node 22.3.0 (from this PC)', 'would provision Python 3', 'would provision MinGW-w64 GCC', 'would provision Rust', '.NET SDK', 'would provision bun', 'would provision uv', 'would provision Git for Windows from this PC'].every((s) => r1.out.includes(s)), 'guest provisions nvm/Node, Python, MinGW, Rust, .NET, Bun, uv, Git');
  const claudeState = path.join(data1, 'state', 'claude');
  check(fs.readFileSync(path.join(claudeState, 'settings.json'), 'utf8').includes('dark') && fs.existsSync(path.join(claudeState, 'commands', 'review.md')) && !fs.existsSync(path.join(claudeState, '.credentials.json')), 'guest applied host Claude settings (no login)');
  check(fs.readFileSync(path.join(claudeState, 'plugins', 'installed_plugins.json'), 'utf8').includes(JSON.stringify(claudeState).slice(1, -1)), 'plugin manifests are re-pointed at the sandbox Claude folder');
  const guestState = f.readJson(path.join(claudeState, '.claude.json'));
  check(guestState.mcpServers?.github?.command === 'npx', 'MCP servers from this PC are in the sandbox');
  const manifest = fs.readFileSync(at('managed', 'CLAUDE.md'), 'utf8');
  check(manifest.includes('DISPOSABLE Windows Sandbox') && manifest.includes(f.workA) && manifest.split('\n').length < 16 && fs.readFileSync(path.join(claudeState, 'CLAUDE.md'), 'utf8') === 'my rules' && fs.existsSync(path.join(data1, 'SANDBOX.md')), 'agent manifest goes to the managed CLAUDE.md (tiny); the user CLAUDE.md is untouched');
  check(!fs.existsSync(at('managed', 'managed-settings.json')), 'git access full: no managed deny rules');
  check(r1.out.includes('AgentSandbox-Block-Private') && r1.out.includes('remoteport=1-52,54-65535'), 'guest firewall plan blocks the LAN but keeps DNS to the gateway');
  check(readJsonFile<{ phase: string }>(path.join(data1, 'run', 'sandbox.json'))?.phase === 'ready', 'guest reports "ready" in run/sandbox.json');

  // Second boot: host changed its MCP servers; the sandbox keeps its own .claude.json but gets the new servers.
  fs.writeFileSync(path.join(claudeState, '.claude.json'), JSON.stringify({ ...guestState, oauthAccount: { emailAddress: 'sandbox@x' }, mcpServers: { local: { command: 'x' } } }));
  fs.writeFileSync(path.join(gen.launchPath, 'claude-profile', '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'npx2' } }, projects: { [f.workA.replace(/\\/g, '/')]: { mcpServers: { db: { command: 'pg' } } } } }));
  f.runGuest(gen.launchPath, data1, f.workA);
  const merged = f.readJson(path.join(claudeState, '.claude.json'));
  check(merged.oauthAccount.emailAddress === 'sandbox@x' && merged.mcpServers.github.command === 'npx2' && merged.mcpServers.local.command === 'x' && Object.values(merged.projects as Record<string, { mcpServers?: Record<string, unknown> }>).some((p) => p.mcpServers?.db), 'MCP servers re-sync every boot (user + project scope) without touching the sandbox login');

  const readonlyConfig = f.makeConfig();
  readonlyConfig.provisioning.git.access = 'readonly';
  const genRo = f.generate(await f.run({}, readonlyConfig));
  f.runGuest(genRo.launchPath, at('data-ro'), f.workA, { AGENT_MANAGED_DIR: at('managed-ro') });
  const policy = f.readJson(at('managed-ro', 'managed-settings.json'));
  check(policy.permissions.deny.includes('Bash(git commit:*)') && policy.permissions.deny.includes('PowerShell(git push:*)') && policy.permissions.deny.includes('Edit(**/.git/**)') && !policy.permissions.deny.includes('Bash(git status:*)'), 'git readonly: Claude managed settings deny writing git commands and .git edits');

  const genHook = f.generate(await f.run({ cwd: f.workB, harness: 'claude', trustConfig: true }));
  const rHook = f.runGuest(genHook.launchPath, at('data-hook'), f.workB);
  check(rHook.status === 0 && fs.readFileSync(at('data-hook', 'hook-ran.txt'), 'utf8') === f.workB, 'local "scripts" run inside the sandbox with the workspace set');
  const genInstall = f.generate(await f.run({}, f.makeConfig(false)), [], { ...f.probe, nodeDir: null, harnessExe: null });
  const r3 = f.runGuest(genInstall.launchPath, at('data3'), f.workA, { AGENT_HOST_TOOLS_DIR: at('empty') });
  check(r3.status === 0 && r3.out.includes('npm-cli.js') && r3.out.includes('@anthropic-ai/claude-code') && !fs.readFileSync(genInstall.wsbPath, 'utf8').includes('HostTools'), 'install mode: nothing mapped from this PC, agent installed with npm');
  const r5 = f.runGuest(f.generate(await f.run({ noAgent: true })).launchPath, at('data5'), f.workA);
  check(r5.status === 0 && r5.out.includes('no agent requested'), '--no-agent provisions without an agent');
  return gen.launchPath;
};
