// One-time-per-boot setup inside the sandbox (everything except the toolchains).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Harness } from '../core/types.js';
import { buildFirewallCommands, parseDefaultGateways, parseDnsServers } from '../shared/netrules.js';
import { translatePaths } from '../shared/paths.js';
import { claudeDir, dataDir, dryRun, errMsg, exec, exists, hostToolsDir, isWin, launchDir, log, mkdirp, powershell, robocopy, session, stateDir, toolsDir, warn, workspace } from './env.js';

// ---- environment ------------------------------------------------------------------------------------------------

/** The environment every agent session, hook and new terminal tab gets. */
export const agentEnv = (extra: { vars: Record<string, string>; prepend: string[]; append: string[] }): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra.vars };
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: path.join(stateDir, 'codex'),
    GEMINI_CLI_HOME: path.join(stateDir, 'gemini'),
    npm_config_cache: path.join(toolsDir, 'npm-cache'),
    npm_config_update_notifier: 'false',
    AGENT_WORKSPACE: workspace,
    AGENT_DATA: dataDir,
    AGENT_TOOLS: toolsDir,
    AGENT_PROJECT: session.project,
  });
  for (const dir of [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.GEMINI_CLI_HOME, env.npm_config_cache]) mkdirp(dir as string);
  // The runner's own Node (C:\AgentData\tools\node) is not exposed: `node` is whatever nvm selected.
  const runner = path.join(toolsDir, 'node').toLowerCase();
  const base = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && d.toLowerCase() !== runner);
  env.PATH = [...extra.prepend, ...base, ...extra.append].join(path.delimiter);
  return env;
};

/** Makes the agent environment machine-wide so new terminal tabs and anything the agent spawns see the same tools. */
export const persistEnvironment = (env: NodeJS.ProcessEnv, names: string[]): void => {
  if (!isWin || dryRun) return;
  const vars = Object.fromEntries(names.filter((n) => env[n] !== undefined).map((n) => [n, env[n] as string]));
  const script = [
    "$vars = '" + JSON.stringify(vars).replace(/'/g, "''") + "' | ConvertFrom-Json",
    "foreach ($p in $vars.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, 'Machine') }",
    "[Environment]::SetEnvironmentVariable('Path', '" + (env.PATH ?? '').replace(/'/g, "''") + "', 'Machine')",
  ].join('\n');
  try { powershell(script); } catch (e) { warn('Could not persist the environment machine-wide: ' + errMsg(e)); }
};

// ---- network --------------------------------------------------------------------------------------------------

const netsh = (args: string[]): { status: number | null; out: string } => {
  const r = spawnSync('netsh', args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

const discoverExemptIps = (): string[] => {
  if (process.env.AGENT_TEST_EXEMPT) return process.env.AGENT_TEST_EXEMPT.split(',');
  if (!isWin) return [];
  const route = spawnSync('route', ['print', '-4'], { encoding: 'utf8', windowsHide: true });
  const config = spawnSync('ipconfig', ['/all'], { encoding: 'utf8', windowsHide: true });
  return [...parseDefaultGateways(route.stdout ?? ''), ...parseDnsServers(config.stdout ?? '')];
};

const internetWorks = async (): Promise<boolean> => {
  try { return (await fetch('https://nodejs.org', { method: 'HEAD', signal: AbortSignal.timeout(10000) })).status > 0; } catch { return false; }
};

/** Blocks the LAN (guest firewall) but keeps DNS to the gateway; lets the host reach session ports. */
export const applyNetworkPolicy = async (ptyHostExe: string | null): Promise<void> => {
  if (!session.networking) { log('Networking is disabled for this sandbox.'); return; }
  if (!session.network.blockPrivateRanges) log('Private-range blocking disabled by config.');
  const exempt = discoverExemptIps();
  const commands = session.network.blockPrivateRanges ? buildFirewallCommands(exempt) : [];
  if (ptyHostExe && session.attach.enabled) {
    commands.push(['advfirewall', 'firewall', 'delete', 'rule', 'name=AgentSandbox-Attach']);
    commands.push(['advfirewall', 'firewall', 'add', 'rule', 'name=AgentSandbox-Attach', 'dir=in', 'action=allow', 'enable=yes', 'profile=any', 'protocol=tcp', 'remoteip=LocalSubnet', 'program=' + ptyHostExe]);
  }
  if (commands.length === 0) return;
  log('Gateway/DNS addresses kept reachable for DNS only: ' + (exempt.length ? [...new Set(exempt)].join(', ') : '(none found)'));
  if (!isWin || dryRun) { log('(dry run) firewall plan:'); for (const c of commands) log('  netsh ' + c.join(' ')); return; }
  for (const c of commands) {
    const r = netsh(c);
    if (r.status !== 0 && c[2] !== 'delete') throw new Error('netsh ' + c.slice(0, 5).join(' ') + ' failed (exit ' + r.status + '): ' + r.out.trim());
  }
  if (session.network.blockPrivateRanges && !(await internetWorks())) {
    for (const c of commands) if (c[2] === 'delete') netsh(c);
    throw new Error('Internet check failed after applying the private-range block, so the rules were removed again.');
  }
  if (session.network.blockPrivateRanges) log('LAN blocked in the guest firewall (10/8, 172.16/12, 192.168/16, link-local, multicast, IPv6 local, SMB); DNS/DHCP to the gateway allowed.');
};

/** Guest IPv4 addresses the host can use to reach session ports. */
export const guestAddresses = (): string[] =>
  Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => (i as os.NetworkInterfaceInfo).address);

// ---- hooks ----------------------------------------------------------------------------------------------------

export const runHooks = (stage: string, env: NodeJS.ProcessEnv): void => {
  const dir = path.join(launchDir, 'hooks', stage);
  if (!exists(dir)) return;
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const ext = path.extname(name).toLowerCase();
    const command: [string, string[]] | null =
      ext === '.ps1' && isWin ? ['powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file]]
      : ext === '.mjs' || ext === '.js' ? [process.execPath, [file]]
      : (ext === '.cmd' || ext === '.bat') && isWin ? ['cmd.exe', ['/d', '/c', file]]
      : null;
    if (!command) continue;
    log('Hook [' + stage + ']: ' + name);
    const result = spawnSync(command[0], command[1], { stdio: 'inherit', cwd: workspace, env });
    if (result.status !== 0) {
      const message = 'Hook failed (' + stage + '/' + name + ', exit ' + result.status + ')';
      if (session.hooks.failFast) throw new Error(message);
      warn(message);
    }
  }
};

// ---- agents ---------------------------------------------------------------------------------------------------

const harnessPaths = (name: string, harness: Harness) => {
  const dir = path.join(toolsDir, 'agents', name);
  return { dir, exe: harness.hostExecutable ? path.join(dir, harness.hostExecutable) : null, cmd: harness.npmBin ? path.join(dir, harness.npmBin + '.cmd') : null };
};

const installViaNpm = (name: string, harness: Harness, dir: string, env: NodeJS.ProcessEnv): void => {
  if (!harness.npmPackage) throw new Error('No npmPackage configured for ' + name + ' and no host executable was available.');
  const npmCli = path.join(toolsDir, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = [npmCli, 'install', '--global', '--prefix', dir, harness.npmPackage, '--no-fund', '--no-audit'];
  log('Installing ' + harness.npmPackage + ' (this can take a minute)...');
  if (dryRun) { log('(dry run) ' + process.execPath + ' ' + args.join(' ')); return; }
  if (!exists(npmCli)) throw new Error('npm not found at ' + npmCli);
  exec(process.execPath, args, { env });
};

/** Gets the agent into persistent storage: copied from this PC when possible, otherwise installed with npm. */
export const provisionHarness = (name: string, harness: Harness, env: NodeJS.ProcessEnv): void => {
  const p = harnessPaths(name, harness);
  const cached = (p.exe !== null && exists(p.exe)) || (p.cmd !== null && exists(p.cmd));
  if (cached && !session.provisioning.refresh) { log(name + ' already cached in persistent storage.'); return; }
  mkdirp(p.dir);
  if (session.provisioning.copyFromHost && harness.hostExecutable && name === session.harnessName) {
    const source = path.join(hostToolsDir, 'agents', name, harness.hostExecutable);
    if (exists(source) && p.exe) { fs.copyFileSync(source, p.exe); log('Copied ' + name + ' from this PC: ' + source); return; }
    if (!session.provisioning.fallbackToInstall) throw new Error('Host copy of ' + name + ' unavailable and fallbackToInstall is false.');
    warn('Host copy of ' + name + ' not available; installing instead.');
  }
  installViaNpm(name, harness, p.dir, env);
};

/** Program + arguments that start the agent (a .cmd shim has to go through cmd.exe). */
export const resolveLaunch = (name: string, harness: Harness): { file: string; args: string[] } => {
  const p = harnessPaths(name, harness);
  if (p.exe && exists(p.exe)) return { file: p.exe, args: [] };
  if (p.cmd && exists(p.cmd)) return isWin ? { file: 'cmd.exe', args: ['/d', '/c', p.cmd] } : { file: p.cmd, args: [] };
  if (dryRun) return { file: p.exe ?? p.cmd ?? name, args: [] };
  throw new Error('Cannot find an executable for ' + name + ' after provisioning.');
};

// ---- Claude settings, plugins and claude-mem ----------------------------------------------------------------------

/** Plugin manifests store absolute paths to the plugin cache; point them at the sandbox's Claude folder. */
const fixPluginPaths = (hostConfigDir: string | null): void => {
  const plugins = path.join(claudeDir, 'plugins');
  if (!hostConfigDir || !exists(plugins)) return;
  for (const name of fs.readdirSync(plugins).filter((f) => f.endsWith('.json'))) {
    const file = path.join(plugins, name);
    const text = fs.readFileSync(file, 'utf8');
    const fixed = translatePaths(text, hostConfigDir, claudeDir);
    if (fixed !== text) fs.writeFileSync(file, fixed, 'utf8');
  }
};

export const syncClaudeProfile = (): void => {
  const profile = session.claudeProfile;
  if (profile.items.length === 0) { log('No Claude settings were staged from this PC.'); return; }
  const source = path.join(launchDir, 'claude-profile');
  mkdirp(claudeDir);
  const keepGuestCopy = ['.claude.json', '.credentials.json'];
  for (const name of profile.items) {
    const from = path.join(source, name);
    const to = path.join(claudeDir, name);
    if (!exists(from)) continue;
    if ((keepGuestCopy.includes(name) || !profile.overwrite) && exists(to)) { log('Claude settings: kept the sandbox\'s ' + name); continue; }
    fs.cpSync(from, to, { recursive: true, force: true });
    log('Claude settings: copied ' + name + ' from this PC');
  }
  fixPluginPaths(profile.hostConfigDir);
  if (profile.credentials) warn('Your host Claude LOGIN was copied into the sandbox (copyCredentials is true).');
};

/** claude-mem keeps SQLite + a vector store; they live on the sandbox's own disk and are mirrored to persistent storage. */
export const claudeMemPaths = { store: path.join(stateDir, 'claude-mem'), local: path.join(os.homedir(), '.claude-mem') };

export const restoreClaudeMem = (): void => {
  if (!session.claudeProfile.syncClaudeMem || !exists(claudeMemPaths.store) || dryRun) return;
  robocopy(claudeMemPaths.store, claudeMemPaths.local);
  log('claude-mem data restored from persistent storage.');
};

/** Copies the live claude-mem folder back to persistent storage (staging folder + swap, never a half copy). */
export const saveClaudeMem = (): void => {
  if (!session.claudeProfile.syncClaudeMem || !exists(claudeMemPaths.local) || dryRun) return;
  const incoming = claudeMemPaths.store + '.incoming';
  fs.rmSync(incoming, { recursive: true, force: true });
  fs.cpSync(claudeMemPaths.local, incoming, { recursive: true, filter: (src) => !/\.(pid|lock)$/i.test(src) });
  fs.rmSync(claudeMemPaths.store, { recursive: true, force: true });
  fs.renameSync(incoming, claudeMemPaths.store);
};

// ---- desktop ----------------------------------------------------------------------------------------------------

/** Imports the host's look (registry values + wallpaper) and restarts Explorer so it applies. */
export const applyPersonalization = (): void => {
  const dir = path.join(launchDir, 'personalize');
  if (!session.personalization || !exists(dir) || dryRun || !isWin) return;
  exec('reg.exe', ['import', path.join(dir, 'personalize.reg')], { stdio: 'ignore' });
  const wallpaper = fs.readdirSync(dir).find((f) => f.startsWith('wallpaper'));
  const local = wallpaper ? path.join(mkdirp(path.join(os.homedir(), 'Pictures')), wallpaper) : null;
  if (wallpaper && local) fs.copyFileSync(path.join(dir, wallpaper), local);
  powershell([
    local ? "Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name WallPaper -Value '" + local.replace(/'/g, "''") + "'" : '',
    "Add-Type -Namespace AgentSandbox -Name Desk -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int SystemParametersInfo(int a, int b, string c, int d);'",
    local ? "[void][AgentSandbox.Desk]::SystemParametersInfo(20, 0, '" + local.replace(/'/g, "''") + "', 3)" : '',
    'Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue',
  ].filter(Boolean).join('\n'));
  log('Desktop personalisation applied from this PC.');
};

/** Your Git identity from this PC, plus safe.directory for the mapped workspace (its owner SID differs in the sandbox). */
export const setupGitConfig = (env: NodeJS.ProcessEnv): void => {
  const source = path.join(launchDir, 'home', '.gitconfig');
  const target = path.join(os.homedir(), '.gitconfig');
  if (exists(source)) fs.copyFileSync(source, target);
  if (dryRun) return;
  spawnSync('git', ['config', '--global', '--add', 'safe.directory', '*'], { env, windowsHide: true, stdio: 'ignore', shell: false });
};
