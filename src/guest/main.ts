// Guest entry point, started by bootstrap.ps1 in the sandbox window. Provisions everything, starts the session
// daemon, asks it for the first agent session and then shows that session in this window.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeGuides } from './guide.js';
import { setupToolchains } from './toolchains/index.js';
import { provisionHarness, resolveLaunch } from './setup/agents.js';
import { restoreClaudeMem, syncClaudeProfile } from './setup/claude.js';
import { agentEnv, persistEnvironment } from './setup/environment.js';
import { runHooks } from './setup/hooks.js';
import { applyNetworkPolicy, type LanState } from './setup/network.js';
import { writeManagedSettings } from './setup/policy.js';
import { applyPersonalization, setupGitConfig } from './setup/user.js';
import { ensurePtyHost } from './ptyhost.js';
import { pruneToolLeftovers } from './toolchains/leftovers.js';
import { wanted } from './toolchains/common.js';
import { configureVscode } from './toolchains/vscode.js';
import { now, readSession, writeJsonAtomic } from '../shared/rundir.js';
import { viewSession } from './view.js';
import { saveBootEnv } from './boot-env.js';
import { primaryProject, saveProjectStatus } from './project-status.js';
import { dataDir, dryRun, errMsg, isWin, localDir, log, logPath, logsDir, mkdirp, run, session, setSandboxStatus, toolsDir, warn, workspace } from './env.js';

const STEPS = 8;
const step = (n: number, title: string): void => { log('\n\x1b[36m[' + n + '/' + STEPS + '] ' + title + '\x1b[0m'); setSandboxStatus(n === 1 ? 'booting' : 'provisioning', '[' + n + '/' + STEPS + '] ' + title); };
const soft = async (what: string, work: () => unknown): Promise<void> => { try { await work(); } catch (e) { warn(what + ' failed (continuing): ' + errMsg(e)); } };

const startDaemon = (env: NodeJS.ProcessEnv): void => {
  spawn(process.execPath, [path.join(path.dirname(process.argv[1]), 'daemon.js')], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, AGENT_LOG_PREFIX: 'daemon' } }).unref();
};

/** `sbx-db` for terminals and `sandbox db`: this boot's Node running runtime\db.js (on the sandbox's disk, rewritten each boot). */
const writeDbCommand = (): string => {
  const dir = mkdirp(path.join(localDir, 'bin'));
  const db = path.join(path.dirname(process.argv[1]), 'db.js');
  fs.writeFileSync(path.join(dir, 'sbx-db.cmd'), '@setlocal\r\n@set AGENT_LOG_PREFIX=db\r\n@"' + process.execPath + '" "' + db + '" %*\r\n');
  return dir;
};

const waitForPrimary = async (): Promise<boolean> => {
  for (let i = 0; i < 600; i++) {
    const s = readSession(dataDir, session.launchId);
    if (s?.phase === 'running') return true;
    if (s?.phase === 'failed' || s?.phase === 'exited') { warn(s.message); return false; }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const main = async (): Promise<void> => {
  log('Agent sandbox: ' + session.project + ' | workspace ' + workspace + ' | agent ' + session.harnessName + ' | log ' + logPath);
  if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Workspace folder is missing in the sandbox: ' + workspace);
  mkdirp(toolsDir);
  mkdirp(run.run);

  step(1, 'Network and session host');
  let ptyHost: string | null = null;
  if (isWin && !dryRun && session.attach.enabled) await soft('Building the session host', () => { ptyHost = ensurePtyHost(); });
  let lan: LanState = session.networking ? 'open' : 'offline';
  await soft('Private-network blocking', async () => { lan = await applyNetworkPolicy(ptyHost); });

  step(2, 'Pre-provision hooks and desktop');
  runHooks('pre-provision', process.env);
  await soft('Personalisation', applyPersonalization);

  const gitAccess = session.provisioning.git.access ?? 'full';
  step(3, 'Developer tools (the first start downloads them once; later starts are quick)');
  const basePath = process.env.PATH ?? '';
  const tools = await setupToolchains(session.toolchains, session.versions, {
    gitEnabled: session.provisioning.git.enabled, gitAccess, hostGit: session.hostTools.git, refresh: session.provisioning.refresh, databases: session.databases ?? [], apps: session.apps,
  });
  if (!dryRun) tools.prepend.push(writeDbCommand());
  const vscode = session.toolchains.vscode;
  if (vscode.enabled && vscode.setup !== false) {
    const languages = ['python', 'java', 'go', 'rust', 'cpp', 'msvc', 'dotnet', 'ruby', 'php', 'deno', 'pwsh'].filter((t) => wanted((session.toolchains as unknown as Record<string, { enabled: boolean | 'auto' }>)[t]?.enabled ?? false, t));
    await soft('VS Code setup', () => configureVscode(tools, { toolchains: ['node', ...languages], databases: (session.databases ?? []).map((d) => d.database), config: vscode, workspace }));
  }
  const env = agentEnv(tools);
  persistEnvironment(env, Object.keys(tools.vars));
  saveBootEnv({ basePath, toolVars: Object.keys(tools.vars), steps: tools.steps, summary: tools.summary, lan });
  saveProjectStatus(primaryProject(), workspace, 'ready', 'Ready', session.databases ?? [], tools.summary);
  for (const line of tools.summary) log('  ' + line);
  await soft('Cleaning old tool builds', () => pruneToolLeftovers());

  step(4, 'Git identity');
  await soft('Git config', () => setupGitConfig(env));

  step(5, 'Claude settings, history and claude-mem');
  if (session.harnessName === 'claude') await soft('Claude settings', syncClaudeProfile);
  await soft('claude-mem restore', restoreClaudeMem);
  await soft('Sandbox guide for the agent', () => writeGuides(tools.summary, lan));
  await soft('Claude managed settings', () => writeManagedSettings(gitAccess));

  step(6, 'Agent: ' + session.harnessName);
  if (session.harness) await provisionHarness(session.harnessName, session.harness, env);

  step(7, 'Pre-agent hooks');
  runHooks('pre-agent', env);

  step(8, 'Starting ' + session.harnessName);
  setSandboxStatus('ready', 'Ready');
  // No agent, or a restart that adds a project (the host opens its sessions itself once the sandbox is ready).
  if (!session.harness || session.autoSession === false) { if (!dryRun) startDaemon(env); log('Ready' + (session.harness ? '' : ' (no agent requested)') + '. Workspace: ' + workspace); return; }
  if (dryRun) {
    const launch = resolveLaunch(session.harnessName, session.harness);
    log('(dry run) would run: ' + [launch.file, ...launch.args, ...session.harness.arguments, ...session.harnessArguments].join(' ') + ' | cwd=' + workspace);
    runHooks('post-agent', env);
    return;
  }
  startDaemon(env);
  writeJsonAtomic(run.request(session.launchId), { kind: 'session', id: session.launchId, harness: session.harnessName, args: session.harnessArguments, cwd: workspace, createdAt: now() });
  if (!(await waitForPrimary())) throw new Error('The agent session did not start. Logs: ' + logsDir);
  log('If Claude asks you to sign in, do it once; the login is saved in persistent storage.');
  if (process.stdin.isTTY) await viewSession(session.launchId);
  log('\nThis window stays open in ' + workspace + '. Other sessions keep running in their own tabs.');
};

main().catch((e: unknown) => {
  const message = errMsg(e) + (e instanceof Error && e.stack ? '\n' + e.stack : '');
  try { setSandboxStatus('failed', errMsg(e)); fs.writeFileSync(path.join(logsDir, 'guest-error.txt'), message); } catch { /* ignore */ }
  // The window gets the plain message; the stack trace is in guest-error.txt.
  console.error('\n\x1b[31mThe sandbox could not start: ' + errMsg(e) + '\x1b[0m\nDetails: ' + path.join(logsDir, 'guest-error.txt'));
  process.exitCode = 1;
});

