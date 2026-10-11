// `launch` / `generate`, and what claude-sbx runs: start a sandbox, or another session in the running one.
import { activateAccount, activeAccount, defaultAccount } from '../../host/accounts.js';
import { attachTerminal, findUnwatchedSession, requestSession, resetRunDir, waitForReady, waitForSession } from '../../host/channel.js';
import { describePrune, pruneStorage } from '../../host/cleanup.js';
import { generateSandbox } from '../../host/generate.js';
import { findSecretFiles } from '../../host/secrets.js';
import { checkRepo, saveRepoSnapshot } from '../../host/repo-guard.js';
import { assertCanLaunch, isSandboxRunning, probeHost, spawnDetached, startSandbox } from '../../host/platform.js';
import { ensureTerminal } from '../../host/terminal.js';
import { hideSandboxWindow } from '../../host/window.js';
import { readSandboxStatus } from '../../shared/rundir.js';
import { syncBeforeLaunch, watcherRunning } from '../../sync/watcher.js';
import type { Config, ResolvedRun } from '../../core/types.js';
import { errMsg, fail, sleep } from '../../core/util.js';
import { askYesNo, resolveRun } from '../../core/workspace.js';
import { currentGuestDir, sandboxAlive, table, type Context } from './context.js';

/** The sandbox writes sandbox.json a few seconds into its boot; a second launch right after the first waits for it. */
const runningSandboxStatus = async (dataPath: string) => {
  for (let i = 0; i < 60; i++) {
    const status = readSandboxStatus(dataPath);
    if (status) return status;
    await sleep(1000);
  }
  return fail('A Windows Sandbox is running that agent-sandbox did not start (or that uses another storage.dataName).', 'Close that sandbox window first, then run claude-sbx again.');
};

/** A sandbox is already running: open another agent session in it (new tab inside; optionally attach here). */
const launchIntoRunning = async (ctx: Context): Promise<number> => {
  const { options, loaded, dataPath } = ctx;
  const status = await runningSandboxStatus(dataPath);
  const ready = status.phase === 'ready' ? status : await waitForReady(dataPath, status.launchId, sandboxAlive);
  const cwd = currentGuestDir(ctx, ready.workspaceHost, ready.guestWorkspace);
  const harness = options.harness ?? loaded.config.defaultHarness;
  // -t with nothing new for the agent: pick up this folder's session if no terminal on this PC shows it (its tab was
  // closed, or you detached). Someone already attached, --new, or agent arguments: a new session, as before.
  const reuse = options.terminal && !options.newSession && options.passthrough.length === 0 && loaded.config.attach.reuseSession;
  const existing = reuse ? await findUnwatchedSession(dataPath, harness, cwd) : null;
  if (existing) {
    console.log('Reattaching to ' + harness + ' session ' + existing.id + ' in ' + cwd + ' (no other terminal is attached; --new starts another).');
    return attachTerminal(existing);
  }
  console.log('Sandbox already running: starting another ' + harness + ' session in ' + cwd);
  const session = await waitForSession(dataPath, requestSession(dataPath, harness, options.passthrough, cwd), sandboxAlive);
  if (options.terminal) return attachTerminal(session);
  console.log('Session ' + session.id + ' opened in a new tab inside the sandbox. Attach here with: agent-sandbox attach ' + session.id + (ready.headless ? '   (headless: sbx-show opens the window)' : ''));
  return 0;
};

const syncSummary = (config: Config, dataPath: string, workspaceHost: string): string => {
  try {
    const s = syncBeforeLaunch(config, dataPath, workspaceHost);
    return s.history + ' file(s) of history in, claude-mem ' + s.claudeMem;
  } catch (e) { return 'FAILED: ' + errMsg(e); }
};

/** Everything a real launch does before the sandbox starts (skipped by `generate`, which only writes files). */
const prepare = async (ctx: Context, run: ResolvedRun) => {
  const { options, dataPath, storageRoot } = ctx;
  const { config } = run;
  const account = options.account ?? defaultAccount(storageRoot);
  if (account && run.harnessName === 'claude' && account !== activeAccount(dataPath)) activateAccount(storageRoot, dataPath, account);
  const terminal = config.provisioning.terminal.enabled ? await ensureTerminal(dataPath, config.provisioning.refresh) : { exe: null, message: 'disabled' };
  const history = syncSummary(config, dataPath, run.workspaceHost);
  const guarded = checkRepo(dataPath);
  if (guarded.length) console.warn('\x1b[33mSECURITY: neutralised ' + guarded.length + ' change(s) the last sandbox made that could run code on this PC (see agent-sandbox status).\x1b[0m');
  saveRepoSnapshot(dataPath, run.workspaceHost);
  resetRunDir(dataPath);
  return { account, terminal: terminal.message, history, pruned: describePrune(pruneStorage(storageRoot)) };
};

export const launch = async (ctx: Context, generateOnly = false): Promise<number> => {
  const { options, loaded, packageRoot, dataPath, storageRoot } = ctx;
  if (!generateOnly && isSandboxRunning()) return launchIntoRunning(ctx);
  const run = await resolveRun({
    packageRoot, loaded, cwd: process.cwd(), workspace: options.workspace, harness: options.harness, noAgent: options.noAgent,
    noLocalConfig: options.noLocalConfig, trustConfig: options.trustConfig, scripts: options.scripts, headless: options.headless,
    nodeVersion: options.node, pythonVersion: options.python, ask: askYesNo,
  });
  const { config } = run;
  if (!generateOnly) assertCanLaunch();
  const prepared = generateOnly ? null : await prepare(ctx, run);
  const generated = generateSandbox({ packageRoot, run, harnessArgs: options.passthrough, probe: probeHost(config, run.harnessName) });

  for (const note of run.notes) console.log(note);
  const secretFiles = config.secrets.warnFiles ? findSecretFiles(run.workspaceHost) : [];
  if (secretFiles.length) console.warn('\x1b[33mHeads-up: the agent can read these files in your workspace, which often hold secrets: ' + secretFiles.slice(0, 12).join(', ') + (secretFiles.length > 12 ? ', ...' : '') + '. Move real credentials out of the folder (or use test ones). Silence with secrets.warnFiles = false.\x1b[0m');
  table([
    ['Workspace', run.workspaceHost + '  ->  ' + config.guestWorkspace + (config.readOnly ? '  (read-only)' : '')],
    ['Agent', run.harnessName + (prepared?.account ? '  (account: ' + prepared.account + ')' : '') + '   Memory: ' + generated.memoryMb + ' MB   Network: ' + config.sandbox.networking + (config.sandbox.headless ? '   HEADLESS' : '')],
    ['Node', run.versions.node.spec + ' (' + run.versions.node.source + ')   Python: ' + run.versions.python.spec + ' (' + run.versions.python.source + ')'],
    ...(prepared ? [['Terminal', prepared.terminal], ['History', prepared.history], ['Cleanup', prepared.pruned]] : []),
    ['Desktop', generated.personalization],
    ['Claude', generated.profile.staged.length ? generated.profile.staged.join(', ') + (generated.profile.credentials ? '  (INCLUDING YOUR LOGIN)' : '') : 'no settings copied'],
    ['Secrets', !config.secrets.strip ? 'NOT stripped (secrets.strip is off)' : generated.profile.secretsRemoved.length ? 'kept on this PC: ' + generated.profile.secretsRemoved.join(', ') + '  (secrets.allow lets one through)' : 'none found in what is copied'],
    ...generated.mappings.slice(3).map((m) => ['  map ' + (m.readOnly ? 'ro' : 'rw'), m.host + '  ->  ' + m.guest]),
    ['Generated', generated.wsbPath],
  ]);
  if (generateOnly) return 0;

  startSandbox(generated.wsbPath);
  if (!watcherRunning(dataPath)) spawnDetached(ctx.entry, ['_watch', ...(options.config ? ['--config', options.config] : [])]);
  // Hiding runs alongside; a failure to find the window must never break the launch or an attach.
  const hidden = config.sandbox.headless ? hideSandboxWindow(storageRoot).catch(() => false) : null;
  if (options.terminal) {
    console.log('Waiting for the sandbox (first boot downloads toolchains; later boots take seconds) ...');
    await waitForReady(dataPath, generated.launchId, sandboxAlive);
    return attachTerminal(await waitForSession(dataPath, generated.launchId, sandboxAlive));
  }
  if (hidden) console.log(await hidden ? 'Sandbox running headless. Open the window: sbx-show   Attach here: claude-sbx -t' : 'Could not find the sandbox window to hide (it may still be starting); run agent-sandbox hide in a moment.');
  else console.log('Sandbox starting. ' + run.harnessName + ' opens in Windows Terminal inside it. Attach here any time: claude-sbx -t');
  return 0;
};
