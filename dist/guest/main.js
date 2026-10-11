import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { buildFirewallCommands, parseDefaultGateways, parseDnsServers } from './netrules.js';
//TS import type { GuestSession, Harness } from '../types.js';

const isWin = process.platform === 'win32';
const launchDir = process.env.AGENT_LAUNCH_DIR ?? 'C:\\AgentLaunch';
const dataDir = process.env.AGENT_DATA_DIR ?? 'C:\\AgentData';
const hostToolsDir = process.env.AGENT_HOST_TOOLS_DIR ?? 'C:\\HostTools';
const dryRun = process.env.AGENT_DRY_RUN === '1';
const session = JSON.parse(fs.readFileSync(path.join(launchDir, 'session.json'), 'utf8').replace(/^\uFEFF/, ''))/*as GuestSession*/;
const workspace = process.env.AGENT_WORKSPACE ?? session.workspace;
const toolsDir = path.join(dataDir, 'tools');
const logsDir = path.join(dataDir, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, 'guest-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log');

function log(message/*: string*/)/*: void*/ { console.log(message); fs.appendFileSync(logFile, message + '\n'); }
function warn(message/*: string*/)/*: void*/ { console.warn('WARNING: ' + message); fs.appendFileSync(logFile, 'WARNING: ' + message + '\n'); }
function errMsg(e/*: unknown*/)/*: string*/ { return e instanceof Error ? e.message : String(e); }
function exists(p/*: string*/)/*: boolean*/ { return fs.existsSync(p); }
function prependPath(dir/*: string*/)/*: void*/ { process.env.PATH = dir + path.delimiter + (process.env.PATH ?? ''); }
function step(n/*: number*/, title/*: string*/)/*: void*/ { log('\n[' + n + '/7] ' + title); }

function baseEnv()/*: NodeJS.ProcessEnv*/ {
  const env/*: NodeJS.ProcessEnv*/ = { ...process.env };
  const state = session.persistAgentState ? path.join(dataDir, 'state') : path.join(dataDir, 'state-session');
  env.CLAUDE_CONFIG_DIR = path.join(state, 'claude');
  env.CODEX_HOME = path.join(state, 'codex');
  env.GEMINI_CLI_HOME = path.join(state, 'gemini');
  env.npm_config_cache = path.join(toolsDir, 'npm-cache');
  env.npm_config_update_notifier = 'false';
  env.AGENT_WORKSPACE = workspace;
  env.AGENT_DATA = dataDir;
  env.AGENT_TOOLS = toolsDir;
  env.AGENT_PROJECT = session.project;
  for (const dir of [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.GEMINI_CLI_HOME, env.npm_config_cache]) fs.mkdirSync(dir, { recursive: true });
  return env;
}

function netsh(args/*: string[]*/)/*: { status: number | null; out: string }*/ {
  const r = spawnSync('netsh', args, { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function discoverExemptIps()/*: string[]*/ {
  if (process.env.AGENT_TEST_EXEMPT) return process.env.AGENT_TEST_EXEMPT.split(',');
  if (!isWin) return [];
  const route = spawnSync('route', ['print', '-4'], { encoding: 'utf8' });
  const config = spawnSync('ipconfig', ['/all'], { encoding: 'utf8' });
  return [...parseDefaultGateways(route.stdout ?? ''), ...parseDnsServers(config.stdout ?? '')];
}

async function internetWorks()/*: Promise<boolean>*/ {
  try { const response = await fetch('https://nodejs.org', { method: 'HEAD', signal: AbortSignal.timeout(10000) }); return response.status > 0; } catch { return false; }
}

async function applyNetworkPolicy()/*: Promise<void>*/ {
  if (!session.networking || !session.network.blockPrivateRanges) { log('Private-range blocking disabled by config.'); return; }
  const exempt = discoverExemptIps();
  const commands = buildFirewallCommands(exempt);
  log('Gateway/DNS addresses kept reachable for DNS only: ' + (exempt.length ? [...new Set(exempt)].join(', ') : '(none found)'));
  if (!isWin || dryRun) { log('(dry run) firewall plan:'); for (const c of commands) log('  netsh ' + c.join(' ')); return; }
  for (const c of commands) {
    const isDelete = c[2] === 'delete';
    const r = netsh(c);
    if (r.status !== 0 && !isDelete) throw new Error('netsh ' + c.slice(0, 4).join(' ') + ' failed (exit ' + r.status + '): ' + r.out.trim());
  }
  if (!(await internetWorks())) {
    for (const c of commands) if (c[2] === 'delete') netsh(c);
    throw new Error('Internet check failed after applying the private-range block, so the rules were removed again.');
  }
  log('Private ranges (10/8, 172.16/12, 192.168/16, link-local, multicast, IPv6 local) and SMB are blocked in the guest firewall; only DNS/DHCP to the sandbox gateway is allowed. Guest-enforced only.');
}

function runHooks(stage/*: string*/)/*: void*/ {
  const dir = path.join(launchDir, 'hooks', stage);
  if (!exists(dir)) return;
  const env = baseEnv();
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const ext = path.extname(name).toLowerCase();
    let command/*: string | null*/ = null;
    let args/*: string[]*/ = [];
    if (ext === '.ps1' && isWin) { command = 'powershell.exe'; args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file]; }
    else if (ext === '.mjs' || ext === '.js') { command = process.execPath; args = [file]; }
    else if ((ext === '.cmd' || ext === '.bat') && isWin) { command = 'cmd.exe'; args = ['/d', '/c', file]; }
    if (!command) continue;
    log('Hook [' + stage + ']: ' + name);
    const result = spawnSync(command, args, { stdio: 'inherit', cwd: workspace, env });
    if (result.status !== 0) {
      const message = 'Hook failed (' + stage + '/' + name + ', exit ' + result.status + ')';
      if (session.hooks.failFast) throw new Error(message);
      warn(message);
    }
  }
}

async function download(url/*: string*/, destination/*: string*/)/*: Promise<void>*/ {
  const response = await fetch(url, { headers: { 'User-Agent': 'agent-sandbox' } });
  if (!response.ok) throw new Error('Download failed ' + response.status + ': ' + url);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}
function sha256(file/*: string*/)/*: string*/ { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function extractZip(zip/*: string*/, destination/*: string*/)/*: void*/ {
  fs.mkdirSync(destination, { recursive: true });
  let result = spawnSync('tar.exe', ['-xf', zip, '-C', destination], { stdio: 'inherit' });
  if (result.status !== 0) {
    result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', "Expand-Archive -LiteralPath '" + zip + "' -DestinationPath '" + destination + "' -Force"], { stdio: 'inherit' });
  }
  if (result.status !== 0) throw new Error('Could not extract ' + zip);
}
function findFile(root/*: string*/, name/*: string*/)/*: string | null*/ {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    if (entry.isDirectory()) { const found = findFile(full, name); if (found) return found; }
  }
  return null;
}
async function githubAsset(repo/*: string*/, pattern/*: RegExp*/)/*: Promise<{ url: string; name: string; sha256: string | null }>*/ {
  const response = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', { headers: { 'User-Agent': 'agent-sandbox', Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error('GitHub API ' + response.status + ' for ' + repo);
  const release = await response.json()/*as { assets: { name: string; browser_download_url: string; digest?: string }[] }*/;
  const asset = release.assets.find((a/*: { name: string }*/) => pattern.test(a.name));
  if (!asset) throw new Error('No matching asset in latest ' + repo + ' release');
  return { url: asset.browser_download_url, name: asset.name, sha256: asset.digest && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : null };
}

async function provisionGit()/*: Promise<void>*/ {
  if (!session.provisioning.git.enabled) { log('Git disabled by config.'); return; }
  const gitRoot = path.join(toolsDir, 'git');
  let gitExe/*: string | null*/ = exists(gitRoot) ? findFile(gitRoot, 'git.exe') : null;
  if (!gitExe) {
    if (dryRun) { log('(dry run) would download MinGit'); return; }
    const asset = await githubAsset('git-for-windows/git', /^MinGit-[\d.]+-64-bit\.zip$/);
    const zip = path.join(toolsDir, asset.name);
    log('Downloading ' + asset.name);
    await download(asset.url, zip);
    if (asset.sha256 && sha256(zip) !== asset.sha256) throw new Error('MinGit checksum mismatch');
    extractZip(zip, gitRoot);
    fs.rmSync(zip, { force: true });
    gitExe = findFile(gitRoot, 'git.exe');
  }
  if (!gitExe) throw new Error('git.exe not found after extraction');
  prependPath(path.dirname(gitExe));
  log('Git ready: ' + gitExe);
}

async function provisionTerminal()/*: Promise<string | null>*/ {
  if (!session.provisioning.terminal.enabled) return null;
  const root = path.join(toolsDir, 'terminal');
  let exe = exists(root) ? findFile(root, 'WindowsTerminal.exe') : null;
  if (!exe) {
    if (dryRun) { log('(dry run) would download Windows Terminal'); return null; }
    const asset = await githubAsset('microsoft/terminal', /^Microsoft\.WindowsTerminal_[\d.]+_x64\.zip$/);
    const zip = path.join(toolsDir, asset.name);
    log('Downloading ' + asset.name);
    await download(asset.url, zip);
    if (asset.sha256 && sha256(zip) !== asset.sha256) throw new Error('Terminal checksum mismatch');
    extractZip(zip, root);
    fs.rmSync(zip, { force: true });
    exe = findFile(root, 'WindowsTerminal.exe');
  }
  if (!exe) throw new Error('WindowsTerminal.exe not found after extraction');
  fs.writeFileSync(path.join(path.dirname(exe), '.portable'), '');
  log('Windows Terminal ready: ' + exe);
  return exe;
}

function harnessPaths(name/*: string*/, harness/*: Harness*/)/*: { dir: string; exe: string | null; cmd: string | null }*/ {
  const dir = path.join(toolsDir, 'agents', name);
  return { dir, exe: harness.hostExecutable ? path.join(dir, harness.hostExecutable) : null, cmd: harness.npmBin ? path.join(dir, harness.npmBin + '.cmd') : null };
}

function installViaNpm(name/*: string*/, harness/*: Harness*/, dir/*: string*/)/*: void*/ {
  if (!harness.npmPackage) throw new Error('No npmPackage configured for ' + name + ' and no host executable was available.');
  const npmCli = path.join(toolsDir, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = [npmCli, 'install', '--global', '--prefix', dir, harness.npmPackage, '--no-fund', '--no-audit'];
  log('Installing ' + harness.npmPackage + ' (this can take a minute)...');
  if (dryRun) { log('(dry run) ' + process.execPath + ' ' + args.join(' ')); return; }
  if (!exists(npmCli)) throw new Error('npm not found at ' + npmCli);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: baseEnv() });
  if (result.status !== 0) throw new Error('npm install failed with exit code ' + result.status);
}

function provisionHarness(name/*: string*/, harness/*: Harness*/)/*: void*/ {
  const p = harnessPaths(name, harness);
  const cached = (p.exe !== null && exists(p.exe)) || (p.cmd !== null && exists(p.cmd));
  if (cached && !session.provisioning.refresh) { log(name + ' already cached in persistent storage.'); return; }
  fs.mkdirSync(p.dir, { recursive: true });
  if (session.provisioning.copyFromHost && harness.hostExecutable) {
    const source = path.join(hostToolsDir, 'agents', name, harness.hostExecutable);
    if (exists(source) && p.exe) { fs.copyFileSync(source, p.exe); log('Copied ' + name + ' from this PC: ' + source); return; }
    if (!session.provisioning.fallbackToInstall) throw new Error('Host copy of ' + name + ' unavailable and fallbackToInstall is false.');
    warn('Host copy of ' + name + ' not available; installing instead.');
  }
  installViaNpm(name, harness, p.dir);
}

function syncClaudeProfile()/*: void*/ {
  const profile = session.claudeProfile;
  if (!profile || profile.items.length === 0) { log('No Claude settings were staged from this PC.'); return; }
  const source = path.join(launchDir, 'claude-profile');
  const target = baseEnv().CLAUDE_CONFIG_DIR ?? path.join(dataDir, 'state', 'claude');
  fs.mkdirSync(target, { recursive: true });
  const keepGuestCopy = ['.claude.json', '.credentials.json'];
  for (const name of profile.items) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    if (!exists(from)) continue;
    const onlyIfMissing = keepGuestCopy.includes(name) || !profile.overwrite;
    if (onlyIfMissing && exists(to)) { log('Claude settings: kept existing ' + name + ' in the sandbox'); continue; }
    fs.cpSync(from, to, { recursive: true, force: true });
    log('Claude settings: copied ' + name + ' from this PC');
  }
  if (profile.credentials) warn('Your host Claude LOGIN was copied into the sandbox (copyCredentials is true).');
}

function resolveLaunch(name/*: string*/, harness/*: Harness*/)/*: { file: string; args: string[] }*/ {
  const p = harnessPaths(name, harness);
  if (p.exe && exists(p.exe)) return { file: p.exe, args: [] };
  if (p.cmd && exists(p.cmd)) return isWin ? { file: 'cmd.exe', args: ['/d', '/c', p.cmd] } : { file: p.cmd, args: [] };
  if (dryRun) return { file: p.exe ?? p.cmd ?? name, args: [] };
  throw new Error('Cannot find an executable for ' + name + ' after provisioning.');
}

async function main()/*: Promise<void>*/ {
  log('Agent sandbox guest started. Project: ' + session.project + ' | workspace: ' + workspace + ' | harness: ' + session.harnessName);
  log('Mode: ' + (session.provisioning.copyFromHost ? 'copy from host (fallback to install: ' + session.provisioning.fallbackToInstall + ')' : 'install inside sandbox') + ' | log: ' + logFile);
  if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Workspace folder is missing in the sandbox: ' + workspace);
  fs.mkdirSync(toolsDir, { recursive: true });
  const nodeDir = path.join(toolsDir, 'node');
  if (exists(nodeDir)) prependPath(nodeDir);

  step(1, 'Network policy'); try { await applyNetworkPolicy(); } catch (e) { warn('Private-network blocking NOT applied; the sandbox can still reach your LAN: ' + errMsg(e)); }
  step(2, 'Pre-provision hooks'); runHooks('pre-provision');
  step(3, 'Git'); try { await provisionGit(); } catch (e) { warn('Git setup failed (continuing): ' + errMsg(e)); }
  step(4, 'Windows Terminal'); let terminal/*: string | null*/ = null; try { terminal = await provisionTerminal(); } catch (e) { warn('Terminal setup failed (continuing): ' + errMsg(e)); }

  const env = baseEnv();
  const gitBash = [path.join(toolsDir, 'git', 'bin', 'bash.exe'), path.join(toolsDir, 'git', 'usr', 'bin', 'bash.exe')].find((f/*: string*/) => exists(f));
  if (gitBash) env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;

  if (session.harnessName === 'none' || !session.harness) { step(5, 'No agent requested'); runHooks('pre-agent'); log('Ready. Workspace: ' + workspace); return; }

  step(5, 'Agent: ' + session.harnessName);
  provisionHarness(session.harnessName, session.harness);
  if (session.harnessName === 'claude') syncClaudeProfile();
  const launch = resolveLaunch(session.harnessName, session.harness);
  for (const [k, v] of Object.entries(session.harness.environment ?? {})) env[k] = String(v);

  step(6, 'Pre-agent hooks'); runHooks('pre-agent');

  step(7, 'Starting ' + session.harnessName + ' in ' + workspace);
  const args = [...launch.args, ...session.harness.arguments, ...session.harnessArguments];
  if (dryRun) { log('(dry run) would run: ' + launch.file + ' ' + args.join(' ') + ' | cwd=' + workspace); runHooks('post-agent'); return; }
  if (terminal && session.provisioning.terminal.launchAgentInTerminal) {
    spawn(terminal, ['-d', workspace, launch.file, ...args], { detached: true, stdio: 'ignore', env }).unref();
    log('Agent launched in Windows Terminal.');
    return;
  }
  log('If Claude asks you to sign in, do it once; the login is saved in persistent storage.\n');
  const result = spawnSync(launch.file, args, { stdio: 'inherit', cwd: workspace, env });
  if (result.error) throw result.error;
  log('\n' + session.harnessName + ' exited with code ' + result.status + '. This console stays open in ' + workspace + '.');
  runHooks('post-agent');
}

main().catch((e/*: unknown*/) => {
  const message = errMsg(e) + (e instanceof Error && e.stack ? '\n' + e.stack : '');
  try { fs.appendFileSync(logFile, 'FATAL: ' + message + '\n'); fs.writeFileSync(path.join(logsDir, 'guest-error.txt'), message); } catch { /* ignore */ }
  console.error('\nFATAL: ' + message + '\nLogs: ' + logsDir);
  process.exitCode = 1;
});
