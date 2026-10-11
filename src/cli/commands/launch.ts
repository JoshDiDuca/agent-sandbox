// `launch` / `generate`, and what claude-sbx runs: start a sandbox, or another session in the running one.
import { activateAccount, activeAccount, defaultAccount } from '../../host/accounts.js';
import { attachTerminal, requestSession, resetRunDir, waitForReady, waitForSession } from '../../host/channel.js';
import { describePrune, pruneStorage } from '../../host/cleanup.js';
import { generateSandbox } from '../../host/generate.js';
import { checkRepo, saveRepoSnapshot } from '../../host/repo-guard.js';
import { assertCanLaunch, isSandboxRunning, probeHost, spawnDetached, startSandbox } from '../../host/platform.js';
import { ensureTerminal } from '../../host/terminal.js';
import { hideSandboxWindow } from '../../host/window.js';
import { readSandboxStatus } from '../../shared/rundir.js';
import { syncBeforeLaunch, watcherRunning } from '../../sync/watcher.js';
import { errMsg, fail } from '../../core/util.js';
import { askYesNo, resolveRun } from '../../core/workspace.js';
import { currentGuestDir, sandboxAlive, table, type Context } from './context.js';

/** A sandbox is already running: open another agent session in it (new tab inside; optionally attach here). */
const launchIntoRunning = async (ctx: Context): Promise<number> => {
  const { options, loaded, dataPath } = ctx;
  const status = readSandboxStatus(dataPath) ?? fail('A Windows Sandbox is running but was not started by agent-sandbox (or uses another storage.dataName). Close it first.');
  const ready = status.phase === 'ready' ? status : await waitForReady(dataPath, status.launchId, sandboxAlive);
  const cwd = currentGuestDir(ctx, ready.workspaceHost, ready.guestWorkspace);
  const harness = options.harness ?? loaded.config.defaultHarness;
  console.log('Sandbox already running: starting another ' + harness + ' session in ' + cwd);
  const session = await waitForSession(dataPath, requestSession(dataPath, harness, options.passthrough, cwd), sandboxAlive);
  if (options.terminal) return attachTerminal(session);
  console.log('Session ' + session.id + ' opened in a new tab inside the sandbox. Attach here with: agent-sandbox attach ' + session.id + (ready.headless ? '   (headless: sbx-show opens the window)' : ''));
  return 0;
};

const syncSummary = (run: Parameters<typeof syncBeforeLaunch>[0], dataPath: string, workspaceHost: string): string => {
  try {
    const s = syncBeforeLaunch(run, dataPath, workspaceHost);
    return s.history + ' file(s) of history in, claude-mem ' + s.claudeMem;
  } catch (e) { return 'FAILED: ' + errMsg(e); }
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

  const account = options.account ?? defaultAccount(storageRoot);
  if (account && run.harnessName === 'claude' && account !== activeAccount(dataPath)) activateAccount(storageRoot, dataPath, account);
  const terminal = config.provisioning.terminal.enabled ? await ensureTerminal(dataPath, config.provisioning.refresh) : { exe: null, message: 'disabled' };
  const history = syncSummary(config, dataPath, run.workspaceHost);
  const guarded = checkRepo(dataPath);
  if (guarded.length) console.warn('\x1b[33mSECURITY: neutralised ' + guarded.length + ' git hook/config change(s) made in the previous sandbox run (see agent-sandbox status).\x1b[0m');
  saveRepoSnapshot(dataPath, run.workspaceHost);
  resetRunDir(dataPath);
  const pruned = describePrune(pruneStorage(storageRoot));
  const generated = generateSandbox({ packageRoot, run, harnessArgs: options.passthrough, probe: probeHost(config, run.harnessName) });

  for (const note of run.notes) console.log(note);
  table([
    ['Workspace', run.workspaceHost + '  ->  ' + config.guestWorkspace + (config.readOnly ? '  (read-only)' : '')],
    ['Agent', run.harnessName + (account ? '  (account: ' + account + ')' : '') + '   Memory: ' + generated.memoryMb + ' MB   Network: ' + config.sandbox.networking + (config.sandbox.headless ? '   HEADLESS' : '')],
    ['Node', run.versions.node.spec + ' (' + run.versions.node.source + ')   Python: ' + run.versions.python.spec + ' (' + run.versions.python.source + ')'],
    ['Terminal', terminal.message],
    ['History', history],
    ['Cleanup', pruned],
    ['Desktop', generated.personalization],
    ['Claude', generated.profile.staged.length ? generated.profile.staged.join(', ') + (generated.profile.credentials ? '  (INCLUDING YOUR LOGIN)' : '') : 'no settings copied'],
    ...generated.mappings.slice(3).map((m) => ['  map ' + (m.readOnly ? 'ro' : 'rw'), m.host + '  ->  ' + m.guest]),
    ['Generated', generated.wsbPath],
  ]);
  if (generateOnly) return 0;

  startSandbox(generated.wsbPath);
  if (!watcherRunning(dataPath)) spawnDetached(ctx.entry, ['_watch', ...(options.config ? ['--config', options.config] : [])]);
  const hidden = config.sandbox.headless ? hideSandboxWindow(storageRoot) : null;
  if (options.terminal) {
    console.log('Waiting for the sandbox (first boot downloads toolchains; later boots take seconds) ...');
    await waitForReady(dataPath, generated.launchId, sandboxAlive);
    return attachTerminal(await waitForSession(dataPath, generated.launchId, sandboxAlive));
  }
  if (hidden) console.log(await hidden ? 'Sandbox running headless. Open the window: sbx-show   Attach here: claude-sbx --terminal' : 'Could not find the sandbox window to hide (it may still be starting); use agent-sandbox hide.');
  else console.log('Sandbox starting. ' + run.harnessName + ' opens in Windows Terminal inside it. Attach here any time: claude-sbx --terminal');
  return 0;
};
