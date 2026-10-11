// Attacks a compromised sandbox could try against this PC, and the guards that stop them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activateAccount, saveAccount } from '../host/accounts.js';
import { isSandboxAddress, resetRunDir, sendRequest } from '../host/channel.js';
import { pruneStorage } from '../host/cleanup.js';
import { guardRepo, snapshotRepo } from '../host/repo-guard.js';
import { assertNoLinks, ensureDir, safeText } from '../core/util.js';
import { assertSafeMapping } from '../core/workspace.js';
import { sandboxGlobalState } from '../host/claude-profile.js';
import { findSecretFiles, stripMcpServers, stripSettings } from '../host/secrets.js';
import { detectDatabases } from '../core/detect-databases.js';
import { removeRefusal, safeRemove } from '../shared/safe-remove.js';
import { gitDecision } from '../guest/gitguard.js';
import { gitDenyRules } from '../guest/gitrules.js';
import { encodeFrame, FrameReader, MAX_FRAME_BYTES, OutputFilter } from '../shared/pty-client.js';
import { safeId } from '../shared/rundir.js';
import { GuestRequest, SessionStatus } from '../shared/schema.js';
import { readSyncState, syncHistoryIn, syncHistoryOut, syncStatePath } from '../sync/history.js';
import { syncClaudeMem } from '../sync/claude-mem.js';
import { watch } from '../sync/watcher.js';
import { assertCmdSafePath, hostClaude, spawnDetached, startSandbox } from '../host/platform.js';
import { hideSandboxWindow, showSandboxWindow } from '../host/window.js';
import { ensureTerminal, syncPwshProfile } from '../host/terminal.js';
import { isSafeFileName } from '../shared/paths.js';
import { writeJsonAtomic } from '../shared/rundir.js';
import type { Fixtures } from './fixtures.js';
import type { Harness } from './harness.js';

export const securityTests = async (t: Harness, f: Fixtures): Promise<void> => {
  const { check, rejects, write } = t;
  const at = f.at;

  t.section('links planted by the sandbox');
  const victim = at('victim');
  write(path.join(victim, 'precious.txt'), 'keep me');
  const data = at('evil-storage', 'data', 'd');
  ensureDir(path.join(data, 'state'));
  fs.symlinkSync(victim, path.join(data, 'state', 'claude'), 'junction');
  check(await rejects(() => assertNoLinks(data, path.join(data, 'state', 'claude', 'x.json')), 'is a link'), 'any host write under the data folder through a junction is refused');
  check(await rejects(() => activateAccount(at('evil-storage'), data, 'any'), 'Unknown account') && await rejects(() => saveAccount(at('evil-storage'), data, 'a', null), 'is a link'), 'accounts never read or write through a sandbox junction');
  const guestDot = at('link-guest');
  ensureDir(path.join(guestDot, 'projects'));
  fs.symlinkSync(victim, path.join(guestDot, 'projects', 'C--Workspace-my-app'), 'junction');
  write(at('link-host', 'projects', 'D--Code-my-app', 's.jsonl'), '{}\n');
  syncHistoryIn({ hostClaudeDir: at('link-host'), guestClaudeDir: guestDot, hostWorkspace: 'D:\\Code\\my-app', guestWorkspace: 'C:\\Workspace\\my-app' });
  check(!fs.existsSync(path.join(victim, 's.jsonl')), 'history sync never writes through a junction inside the sandbox state');
  fs.symlinkSync(path.join(victim, 'precious.txt'), path.join(guestDot, 'history.jsonl'), 'file');
  write(at('link-host', 'history.jsonl'), '{"display":"x","timestamp":1}\n');
  syncHistoryIn({ hostClaudeDir: at('link-host'), guestClaudeDir: guestDot, hostWorkspace: 'D:\\Code\\my-app', guestWorkspace: 'C:\\Workspace\\my-app' });
  check(fs.readFileSync(path.join(victim, 'precious.txt'), 'utf8') === 'keep me', 'a file symlink planted in place of history.jsonl is replaced, not written through');
  ensureDir(path.join(data, 'run'));
  fs.symlinkSync(victim, path.join(data, 'run', 'requests'), 'junction');
  check(await rejects(() => sendRequest(data, { kind: 'ping', id: 'p1', createdAt: '' }), 'is a link') && !fs.existsSync(path.join(victim, 'p1.json')), 'requests are never written through a junction');
  fs.symlinkSync(victim, path.join(data, 'run', 'sessions'), 'junction');
  resetRunDir(data);
  check(fs.existsSync(path.join(victim, 'precious.txt')) && !fs.existsSync(path.join(data, 'run', 'sessions')), 'resetting the run folder removes a junction itself, never its target');
  fs.symlinkSync(victim, path.join(data, 'logs'), 'junction');
  const old = new Date(Date.now() - 60 * 86400000);
  fs.utimesSync(path.join(victim, 'precious.txt'), old, old);
  pruneStorage(at('evil-storage'));
  check(fs.existsSync(path.join(victim, 'precious.txt')), 'cleanup never walks into a junction (old files on this PC stay)');

  t.section('host <-> sandbox channel');
  const validRequest = (r: unknown): boolean => GuestRequest.safeParse(r).success;
  const validSession = (s: unknown): boolean => SessionStatus.safeParse(s).success;
  check(await rejects(() => safeId('../evil'), 'invalid id') && !validRequest({ kind: 'shell', id: 'a' }) && !validRequest({ kind: 'exec', id: 'a/b', command: ['x'], cwd: 'C:\\', timeoutSeconds: 1 }) && validRequest({ kind: 'ping', id: 'abc', createdAt: 'x' }) && !validRequest({ kind: 'ping', id: 'abc', createdAt: 'x', extra: 1 }), 'only known request kinds with safe ids are accepted');
  const goodSession = { id: 's1', launchId: 'l', harness: 'claude', cwd: 'C:\\Workspace', message: 'ok', phase: 'running', updatedAt: 'x', startedAt: 'x', attach: { addresses: ['172.20.1.5'], port: 5000, token: 't' } };
  check(validSession(goodSession) && !validSession({ ...goodSession, attach: { ...goodSession.attach, port: 70000 } }) && !validSession({ ...goodSession, phase: 'pwned' }), 'guest session status is shape-checked');
  const ifaces = { 'vEthernet (Default Switch)': [{ address: '172.20.0.1', netmask: '255.255.240.0', family: 'IPv4', internal: false, mac: '', cidr: null }], Ethernet: [{ address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null }] } as unknown as ReturnType<typeof os.networkInterfaces>;
  check(isSandboxAddress('172.20.5.9', ifaces) && !isSandboxAddress('192.168.1.20', ifaces) && !isSandboxAddress('127.0.0.1', ifaces) && !isSandboxAddress('8.8.8.8', ifaces) && !isSandboxAddress('172.20.0.1', ifaces), 'attach only connects into the sandbox\'s Hyper-V subnet (not LAN, loopback, internet or this PC itself)');
  const filter = new OutputFilter();
  const filtered = Buffer.concat([filter.push(Buffer.from('a\x1b]52;c;ZXZpbA==\x07b\x1b]0;title\x07')), filter.push(Buffer.from('c\x1b]5')), filter.push(Buffer.from('2;c;cGF5\x1b\\d'))]).toString('latin1');
  check(filtered === 'a' + 'b\x1b]0;title\x07' + 'c' + 'd', 'clipboard writes (OSC 52) from the sandbox are stripped, even split across chunks; titles pass');
  check(await rejects(() => new FrameReader().push(Buffer.concat([Buffer.from([16]), Buffer.from([0, 0, 0, 0x7f])])), 'frame too large') && new FrameReader().push(encodeFrame(16, Buffer.alloc(MAX_FRAME_BYTES))).length === 1, 'oversized frames are rejected instead of buffered');

  t.section('git access modes');
  const allowed = (args: string[], mode = 'readonly'): boolean => gitDecision(args, mode).allow;
  check(['status', 'log --oneline', 'diff HEAD~1', 'show HEAD', 'blame a.ts', 'branch', 'branch -a', 'branch --contains HEAD', 'tag', 'tag -l v*', 'remote -v', 'config --get user.name', 'stash list', '-C sub status', '--no-pager log'].every((a) => allowed(a.split(' '))), 'readonly: reading commands are allowed');
  check(['commit -m x', 'push', 'add .', 'checkout main', 'switch -c x', 'reset --hard', 'stash', 'stash pop', 'branch new', 'branch -D x', 'tag v1', 'merge x', 'rebase main', 'fetch', 'pull', 'config user.name x', 'remote add o u', '-c core.hooksPath=x status', '--git-dir=x status', 'clean -fd', 'apply p.diff'].every((a) => !allowed(a.split(' '))), 'readonly: anything that writes (or overrides config) is refused');
  check(!allowed(['status'], 'none') && !allowed(['--version'], 'none') && allowed(['commit'], 'full'), 'none: every git call is refused; full: everything allowed');
  const roRules = gitDenyRules('readonly');
  const noneRules = gitDenyRules('none');
  check(gitDenyRules('full').length === 0 && roRules.includes('Bash(git push:*)') && !roRules.some((r) => r.startsWith('Read(')) && noneRules.includes('Bash(git:*)') && noneRules.includes('Read(**/.git/**)'), 'Claude managed deny rules match each mode');

  t.section('repository guard (zero-click code execution on this PC)');
  const repo = at('repo');
  write(path.join(repo, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://example.com/x.git\n');
  write(path.join(repo, '.git', 'hooks', 'pre-commit.sample'), 'sample');
  write(path.join(repo, '.git', 'hooks', 'pre-push'), 'existing hook');
  const before = snapshotRepo(repo)!;
  write(path.join(repo, '.git', 'hooks', 'post-checkout'), 'calc.exe');
  write(path.join(repo, '.git', 'hooks', 'pre-push'), 'changed hook');
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[core]\n\tfsmonitor = calc.exe\n\tsshCommand = evil\n[include]\n\tpath = C:/evil.cfg\n[branch "feature"]\n\tremote = origin\n');
  const findings = guardRepo(repo, before);
  const config = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
  check(!fs.existsSync(path.join(repo, '.git', 'hooks', 'post-checkout')) && !fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-push')) && fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit.sample')) && findings.filter((x) => x.kind === 'hook').length === 2, 'new or changed git hooks are quarantined (samples untouched)');
  check(/# \[agent-sandbox\] disabled.*fsmonitor/.test(config) && /# \[agent-sandbox\] disabled.*sshCommand/.test(config) && /# \[agent-sandbox\] disabled.*path = C:\/evil/.test(config) && /^\tremote = origin$/m.test(config) && /^\turl = https/m.test(config), 'dangerous git config added in the sandbox is disabled; harmless changes and existing lines stay');
  check(guardRepo(repo, before).length === 0, 'the guard is idempotent');

  const repo2 = at('repo2');
  write(path.join(repo2, '.git', 'config'), '[core]\n\tbare = false\n');
  write(path.join(repo2, 'build.cmd'), 'echo legit');
  const before2 = snapshotRepo(repo2);
  write(path.join(repo2, 'node.exe'), 'MZ');
  write(path.join(repo2, 'git.cmd'), 'calc');
  write(path.join(repo2, 'sandbox.cmd'), 'calc');
  write(path.join(repo2, 'opencode.ps1'), 'calc');
  write(path.join(repo2, '.git', 'commondir'), 'C:/evil');
  fs.appendFileSync(path.join(repo2, '.git', 'config'), '[core] fsmonitor = calc.exe\n');
  const found2 = guardRepo(repo2, before2);
  check(!fs.existsSync(path.join(repo2, 'node.exe')) && !fs.existsSync(path.join(repo2, 'git.cmd')) && fs.existsSync(path.join(repo2, 'build.cmd')) && !fs.existsSync(path.join(repo2, 'sandbox.cmd')) && found2.filter((x) => x.kind === 'command').length === 4, 'executables planted under command names (node.exe, git.cmd, sandbox.cmd, opencode.ps1) are quarantined; other scripts stay');
  check(!fs.existsSync(path.join(repo2, '.git', 'commondir')) && /# \[agent-sandbox\] disabled.*fsmonitor/.test(fs.readFileSync(path.join(repo2, '.git', 'config'), 'utf8')), 'a planted commondir and a key on the same line as its [section] are neutralised');
  const repo3 = at('repo3');
  write(path.join(repo3, '.git', 'config'), '[core]\n');
  const before3 = snapshotRepo(repo3);
  fs.rmSync(path.join(repo3, '.git'), { recursive: true });
  fs.symlinkSync(victim, path.join(repo3, '.git'), 'junction');
  check(guardRepo(repo3, before3).some((x) => x.kind === 'git' && x.detail.includes('replaced')), '.git replaced by a link is reported loudly');

  t.section('what reaches the sandbox, and what reaches your terminal');
  const state = sandboxGlobalState({ primaryApiKey: 'sk-secret', oauthAccount: { emailAddress: 'me' }, mcpServers: { a: {} }, theme: 'dark', projects: { 'D:/Code/app': { mcpServers: { db: { env: { TOKEN: 'mine' } } } }, 'D:/Other': { mcpServers: { x: { env: { TOKEN: 'other' } } } } } }, 'D:\\Code\\app');
  check(!('primaryApiKey' in state) && !('oauthAccount' in state) && JSON.stringify(state).includes('mine') && !JSON.stringify(state).includes('other') && (state.theme as string) === 'dark', 'the sandbox gets your MCP servers and this project, never API keys, your account or other projects');

  const secrets = { strip: true, allow: ['AWS_REGION'], patterns: ['ACME_*'], warnFiles: true };
  const removed: string[] = [];
  const settings = stripSettings({ apiKeyHelper: 'aws-vault exec prod -- get-key', model: 'opus', env: {
    AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_REGION: 'eu-west-2', AZURE_CLIENT_SECRET: 'z', ARM_CLIENT_ID: 'id', CLOUDFLARE_API_TOKEN: 't',
    GOOGLE_APPLICATION_CREDENTIALS: 'C:\\key.json', PROD_DB_HOST: 'db.internal', STRIPE_KEY: 'k', ACME_THING: 'a', DATABASE_URL: 'postgres://u:p@h/db',
    INNOCENT: 'AKIAABCDEFGHIJKLMNOP', SAFE_URL: 'https://example.com', DISABLE_TELEMETRY: '1', CLAUDE_CODE_USE_BEDROCK: '1',
  } }, secrets, removed);
  const env = settings.env as Record<string, string>;
  check(!('apiKeyHelper' in settings) && settings.model === 'opus' && Object.keys(env).sort().join() === 'AWS_REGION,CLAUDE_CODE_USE_BEDROCK,DISABLE_TELEMETRY,SAFE_URL' && removed.some((r) => r.endsWith('AWS_SECRET_ACCESS_KEY')),
    'settings.json: AWS, Azure, Google, Cloudflare, prod, payment and database credentials (by name or by value) stay on this PC; secrets.allow and ordinary settings pass');
  const mcp = stripMcpServers({ mcpServers: { gh: { command: 'npx', args: ['server', '--api-key', 'plain', '--verbose', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'], env: { GITHUB_TOKEN: 'g', LOG_LEVEL: 'debug' } } },
    projects: { 'D:/app': { mcpServers: { api: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', Accept: 'json' } } } } } }, secrets, []);
  const gh = (mcp.mcpServers as Record<string, { args: string[]; env: object }>).gh;
  const api = ((mcp.projects as Record<string, { mcpServers: Record<string, { headers: object }> }>)['D:/app']).mcpServers.api;
  check(JSON.stringify(gh.args) === '["server","--api-key","[removed by agent-sandbox]","--verbose","[removed by agent-sandbox]"]' && JSON.stringify(gh.env) === '{"LOG_LEVEL":"debug"}' && JSON.stringify(api.headers) === '{"Accept":"json"}',
    'MCP servers: token env vars, Authorization headers and key arguments are removed, the rest of the server works as before');
  check(JSON.stringify(stripSettings({ env: { AWS_SECRET_ACCESS_KEY: 'y' } }, { ...secrets, strip: false }, [])) === '{"env":{"AWS_SECRET_ACCESS_KEY":"y"}}', 'secrets.strip = false copies settings unchanged');
  const sneaky = stripMcpServers({ mcpServers: { r: { type: 'http', url: 'https://mcp.example.com/mcp?api_key=0123456789abcdef&region=eu', headers: { 'X-API-Key': 'k', 'x-auth-token': 't', Accept: 'json' }, args: ['--api-key=deadbeefdeadbeef', '--header', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz', '--port=8080'] } } }, secrets, []);
  const r = (sneaky.mcpServers as Record<string, { url: string; headers: object; args: string[] }>).r;
  check(r.url === 'https://mcp.example.com/mcp?api_key=REMOVED&region=eu' && JSON.stringify(r.headers) === '{"Accept":"json"}' && r.args[0] === '[removed by agent-sandbox]' && r.args[2] === '[removed by agent-sandbox]' && r.args[3] === '--port=8080',
    'MCP servers: X-API-Key headers, ?api_key= in URLs, --flag=value keys and "Authorization: Bearer" arguments are removed too');
  const evil = ['Server=a;Database=a;'.repeat(12000), 'services:\n  x:\n    image: ' + 'postgres'.repeat(20000) + '!\n', 'Host=a;'.repeat(30000)].map((text, i) => ({ path: ['.env', 'compose.yaml', 'appsettings.json'][i], text }));
  const started = Date.now();
  detectDatabases(evil);
  check(Date.now() - started < 2000, 'database detection stays fast on hostile workspace files (no catastrophic backtracking): ' + (Date.now() - started) + ' ms');
  const profile = os.homedir();
  const refused = [profile, path.dirname(profile), 'C:\\', 'C:\\Windows', '', 'relative\\folder', at('outside-root', 'x')].map((p) => removeRefusal(p, at('safe-root')));
  const allowedTarget = at('safe-root', 'tools', 'go');
  t.write(path.join(allowedTarget, 'go.exe'), 'x');
  safeRemove(allowedTarget, at('safe-root'));
  check(refused.every((r) => r !== null) && !fs.existsSync(allowedTarget),
    'deletes can never reach your profile, a folder above it, a drive root, Windows, a relative path or anything outside their root');
  const ws = at('secret-ws');
  for (const file of ['.env', '.env.example', 'server.pem', 'README.md', 'api/credentials.json', 'node_modules/x/.env']) t.write(path.join(ws, file), 'x');
  check(findSecretFiles(ws).sort().join() === '.env,api\\credentials.json,server.pem', 'secret-looking workspace files are found for the launch warning (templates and dependencies ignored)');

  check(safeText('ok \x1b[31mred\x1b[0m \x1b]52;c;ZXZpbA==\x07\x1b]0;title\x07\x1b[2J\x07end') === 'ok \x1b[31mred\x1b[0m end', 'sandbox text printed on this PC keeps colours but loses every other escape sequence');
  check(await rejects(() => assertSafeMapping(path.join(t.packageRoot, 'dist'), t.packageRoot, at('storage')), 'overlaps') && await rejects(() => assertSafeMapping(at('storage', 'data'), t.packageRoot, at('storage')), 'overlaps'), 'extra mappings may not reach agent-sandbox\'s own folders');

  t.section('names, state files and deletes (hostile sandbox)');
  check(['CON.jsonl', 'nul', 'aux.json', 'COM1.txt', 'a:b', 'x.jsonl.', 'x ', '..', 'a\\b', 'LPT3'].every((n) => !isSafeFileName(n)) && ['C--Workspace-app', 'a.jsonl', '.credentials.json', 'console.jsonl'].every(isSafeFileName), 'device names, streams and trailing dots are not valid names to copy into this PC');
  check(await rejects(() => saveAccount(at('acct-storage'), at('acct-storage', 'data', 'd'), 'index', { claudeDir: victim, globalStateFile: victim }), 'Invalid account name') && await rejects(() => saveAccount(at('acct-storage'), at('acct-storage', 'data', 'd'), 'con', { claudeDir: victim, globalStateFile: victim }), 'Invalid account name'), 'an account cannot be called index or a device name (it would overwrite the index or open a device)');
  check(removeRefusal('\\\\?\\C:\\Users\\someone\\x', '\\\\?\\C:\\Users\\someone') !== null && removeRefusal('C:\\Windows\\Temp\\x', 'C:\\Windows\\Temp') !== null && removeRefusal('C:\\Program Files\\x\\y', 'C:\\Program Files\\x') !== null, 'deletes refuse \\\\?\\ paths and anything inside Windows or Program Files');
  const hist = { hostClaudeDir: at('hist-host'), guestClaudeDir: at('hist-guest'), hostWorkspace: 'D:\\Code\\my-app', guestWorkspace: 'C:\\Workspace\\my-app' };
  write(path.join(hist.guestClaudeDir, 'history.jsonl'), 'not json\n[1,2]\n{"display":"ok","timestamp":2}\n"text"\n');
  syncHistoryOut(hist);
  check(fs.readFileSync(path.join(hist.hostClaudeDir, 'history.jsonl'), 'utf8') === '{"display":"ok","timestamp":2}\n', 'only JSON prompt-history entries come back from the sandbox, nothing else it wrote in that file');
  const stateData = at('state-storage', 'data', 'd');
  write(syncStatePath(stateData), JSON.stringify({ hostClaudeDir: 'relative\\.claude', hostWorkspace: 'D:\\x', guestWorkspace: 'C:\\x' }));
  check(readSyncState(stateData) === null, 'a sync state that points at a relative folder is ignored');
  write(syncStatePath(stateData), JSON.stringify({ hostClaudeDir: at('c'), hostWorkspace: 'D:\\x', guestWorkspace: 'C:\\x', syncHistory: true }));
  check(readSyncState(stateData)?.syncHistory === true, 'a valid sync state is read');
  const repo4 = at('repo4');
  write(path.join(repo4, '.git', 'config'), '[core]\n');
  const before4 = snapshotRepo(repo4);
  fs.appendFileSync(path.join(repo4, '.git', 'config'), '#'.repeat(5 * 1024 * 1024));
  check(guardRepo(repo4, before4).some((x) => x.kind === 'git' && x.detail.includes('over 4 MB')), 'a git config too big to check is reported instead of passing');
  const atomicFile = at('atomic', 'state.json');
  writeJsonAtomic(atomicFile, { a: 1 });
  writeJsonAtomic(atomicFile, { a: 2 });
  check(JSON.parse(fs.readFileSync(atomicFile, 'utf8')).a === 2 && fs.readdirSync(path.dirname(atomicFile)).length === 1, 'state files are replaced whole, with no temp files left behind');
  check(await rejects(() => assertCmdSafePath('C:\\a\\%TEMP%\\agent.wsb'), 'cannot be started safely') && await rejects(() => assertCmdSafePath('C:\\a"&calc&"\\agent.wsb'), 'cannot be started safely'), 'a launch path that cmd.exe would expand is refused');

  t.section('the self-test never acts on this PC');
  const previous = process.env.AGENT_SANDBOX_SELFTEST;
  process.env.AGENT_SANDBOX_SELFTEST = '1';
  try {
    const real = path.join(os.homedir(), 'agent-sandbox-selftest-guard-probe');
    const sync = { ...hist, hostClaudeDir: real };
    const blocked: [string, () => unknown][] = [
      ['start Windows Sandbox', () => startSandbox(at('storage', 'agent.wsb'))],
      ['start the background watcher process', () => spawnDetached(path.join(t.packageRoot, 'dist', 'bin', 'sandbox.js'), ['_watch'])],
      ['run Claude Code on this PC', () => hostClaude(at('storage'), false, ['--version'])],
      ['hide windows', () => hideSandboxWindow(at('storage'), 1)],
      ['show windows', () => showSandboxWindow(at('storage'))],
      ['shut down Windows Sandbox', () => sendRequest(data, { kind: 'exec', id: 'sd', command: ['C:\\Windows\\System32\\shutdown.exe', '/s'], cwd: 'C:\\', timeoutSeconds: 5, createdAt: '' })],
      ['start the background sync', () => watch(at('storage', 'data', 'w'))],
      ['write Windows Terminal settings', () => syncPwshProfile(path.join(os.homedir(), 'agent-sandbox-selftest-guard-probe'), true)],
      ['download Windows Terminal into a profile', () => ensureTerminal(path.join(os.homedir(), 'agent-sandbox-selftest-guard-probe'), true)],
      ['sync history into the real profile', () => syncHistoryOut(sync)],
      ['sync history into the sandbox state in a profile', () => syncHistoryIn({ ...hist, guestClaudeDir: real })],
      ['sync claude-mem into the real profile', () => syncClaudeMem(real, at('mem-store'), { hostClaudeDir: real, hostWorkspace: 'D:\\x', guestWorkspace: 'C:\\x' }, 'out')],
      ['write a state file in a profile', () => writeJsonAtomic(path.join(real, 'x.json'), {})],
      ['delete in a profile', () => safeRemove(path.join(real, 'x'), os.homedir())],
      ['save a login into a profile', () => saveAccount(real, at('acct-storage', 'data', 'd'), 'work', { claudeDir: path.dirname(write(at('guard-login', '.credentials.json'), '{"claudeAiOauth":{}}')), globalStateFile: at('guard-login', '.claude.json') })],
    ];
    for (const [what, action] of blocked) {
      let message = '';
      try { await action(); } catch (e) { message = e instanceof Error ? e.message : String(e); }
      check(/self-test/i.test(message), 'self-test mode refuses to ' + what + (message ? '' : ' (it did not refuse)'));
    }
    check(!fs.existsSync(real), 'nothing was created in the profile folder');
    writeJsonAtomic(at('guard-ok', 'x.json'), { fine: true });
    check(fs.existsSync(at('guard-ok', 'x.json')), 'the temp folder stays writable for the tests');
  } finally {
    if (previous === undefined) delete process.env.AGENT_SANDBOX_SELFTEST; else process.env.AGENT_SANDBOX_SELFTEST = previous;
  }
};
