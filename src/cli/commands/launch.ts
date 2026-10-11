// `launch` / `generate`, and what sandbox claude runs: start a sandbox, or another session in the running one.
import { activateAccount, activeAccount, defaultAccount } from '../../host/accounts.js';
import { attachTerminal, findUnwatchedSession, requestSession, resetRunDir, waitForReady, waitForSession } from '../../host/channel.js';
import { describePrune, pruneStorage } from '../../host/cleanup.js';
import { generateSandbox } from '../../host/generate.js';
import { findSecretFiles } from '../../host/secrets.js';
import { checkRepo, saveRepoSnapshot } from '../../host/repo-guard.js';
import { assertCanLaunch, insideSandbox, isSandboxRunning, probeHost, spawnDetached, startSandbox } from '../../host/platform.js';
import { ensureTerminal } from '../../host/terminal.js';
import { hideSandboxWindow, showSandboxWindow } from '../../host/window.js';
import { readSandboxStatus } from '../../shared/rundir.js';
import path from 'node:path';
import fs from 'node:fs';
import { syncBeforeLaunch, watcherRunning } from '../../sync/watcher.js';
import type { Config, ResolvedRun } from '../../core/types.js';
import { errMsg, fail, sleep } from '../../core/util.js';
import { askYesNo, resolveRun } from '../../core/workspace.js';
import { currentGuestDir, sandboxAlive, table, type Context } from './context.js';

/** Attaches this terminal; with attach.autoHide the sandbox window hides meanwhile (best effort, never fails the attach). */
export const attachHere = (ctx: Context, session: Parameters<typeof attachTerminal>[0]): Promise<number> => {
  if (ctx.loaded.config.attach.autoHide && !insideSandbox()) void hideSandboxWindow(ctx.storageRoot, 120).catch(() => false);
  return attachTerminal(session);
};

/** Nothing has been installed into this data set yet: the first start downloads every toolchain once. */
const firstBoot = (dataPath: string): boolean => !fs.existsSync(path.join(dataPath, 'tools', 'resolved-versions.json'));
const FIRST_BOOT = 'First start for this storage: the sandbox downloads and installs the toolchains, databases and agent this project needs.\n' +
  'That takes a few minutes, once. Everything is kept, so every later start reuses it and takes seconds. Progress:';

/** The sandbox writes sandbox.json a few seconds into its boot; a second launch right after the first waits for it. */
const runningSandboxStatus = async (dataPath: string) => {
  for (let i = 0; i < 60; i++) {
    const status = readSandboxStatus(dataPath);
    if (status) return status;
    await sleep(1000);
  }
  return fail('A Windows Sandbox is running that this tool did not start (or that uses another storage.dataName).', 'Close that sandbox window first, then run sandbox claude again.');
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
    return attachHere(ctx, existing);
  }
  console.log('Sandbox already running: starting another ' + harness + ' session in ' + cwd);
  const session = await waitForSession(dataPath, requestSession(dataPath, harness, options.passthrough, cwd), sandboxAlive);
  if (options.terminal) return attachHere(ctx, session);
  console.log('Session ' + session.id + ' opened in a new tab inside the sandbox. Attach here with: sandbox attach ' + session.id + (ready.headless ? '   (headless: sbx-show opens the window)' : ''));
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
  const terminal = config.provisioning.terminal.enabled ? await ensureTerminal(dataPath, config.provisioning.refresh, { pwsh: config.toolchains.pwsh.enabled !== false }) : { exe: null, message: 'disabled' };
  const history = syncSummary(config, dataPath, run.workspaceHost);
  const guarded = checkRepo(dataPath);
  if (guarded.length) console.warn('\x1b[33mSECURITY: neutralised ' + guarded.length + ' change(s) the last sandbox made that could run code on this PC (see sandbox status).\x1b[0m');
  saveRepoSnapshot(dataPath, run.workspaceHost);
  resetRunDir(dataPath);
  return { account, terminal: terminal.message, history, pruned: describePrune(pruneStorage(storageRoot)) };
};

export const launch = async (ctx: Context, generateOnly = false): Promise<number> => {
  const { options, loaded, packageRoot, dataPath, storageRoot } = ctx;
  // attach.auto: an agent started from an interactive terminal attaches it, as with -t.
  if (loaded.config.attach.auto && !options.noAgent && process.stdin.isTTY && process.stdout.isTTY) options.terminal = true;
  if (!generateOnly && isSandboxRunning()) {
    if (!options.noAgent) return launchIntoRunning(ctx);
    // Only one Windows Sandbox can run: "start" on a running one brings its window up instead.
    console.log('A sandbox is already running' + (showSandboxWindow(storageRoot) ? '; its window is in front now.' : '.') + ' Start an agent in it with sandbox claude (or sandbox <agent>); stop it with sandbox stop.');
    return 0;
  }
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
    ['Toolchains', Object.entries(generated.toolchains).filter(([, d]) => d.on).map(([name, d]) => name + ' (' + d.reason + ')').join(', ') || 'Node only (nothing else used by this project)'],
    ...(generated.databases.length
      ? generated.databases.map((d, i) => [i ? '' : 'Databases', d.database + (d.database === 'sqlserver' ? ' (cannot run in the sandbox; see hostAccess.forwards)' : ' on port ' + d.port) + '  because ' + d.reasons[0] + (d.reasons.length > 1 ? ' (+' + (d.reasons.length - 1) + ' more)' : '')])
      : [['Databases', 'none needed (databases.<name>.enabled = true adds one)']]),
    ['Desktop', generated.personalization],
    ['Claude', generated.profile.staged.length ? generated.profile.staged.join(', ') + (generated.profile.credentials ? '  (INCLUDING YOUR LOGIN)' : '') : 'no settings copied'],
    ['Secrets', !config.secrets.strip ? 'NOT stripped (secrets.strip is off)' : generated.profile.secretsRemoved.length ? 'kept on this PC: ' + generated.profile.secretsRemoved.join(', ') + '  (secrets.allow lets one through)' : 'none found in what is copied'],
    ...generated.mappings.slice(3).map((m) => ['  map ' + (m.readOnly ? 'ro' : 'rw'), m.host + '  ->  ' + m.guest]),
    ['Generated', generated.wsbPath],
  ]);
  if (generateOnly) return 0;

  startSandbox(generated.wsbPath);
  // Absolute: the watcher runs from another folder, and a relative --config there would make it exit silently.
  if (!watcherRunning(dataPath)) spawnDetached(ctx.entry, ['_watch', ...(options.config ? ['--config', path.resolve(options.config)] : [])]);
  // Hiding runs alongside; a failure to find the window must never break the launch or an attach.
  const hidden = config.sandbox.headless ? hideSandboxWindow(storageRoot).catch(() => false) : null;
  if (options.terminal || options.noAgent) {
    console.log(firstBoot(dataPath) ? FIRST_BOOT : 'Waiting for the sandbox (everything it needs is installed already; this takes seconds) ...');
    await waitForReady(dataPath, generated.launchId, sandboxAlive);
    // Without an agent there is no session to attach to: the sandbox itself is the result.
    if (options.noAgent) { console.log('Sandbox ready. Its window has a terminal in ' + config.guestWorkspace + '; from here: sandbox exec -- <command>, sandbox stop.'); return 0; }
    return attachHere(ctx, await waitForSession(dataPath, generated.launchId, sandboxAlive));
  }
  if (firstBoot(dataPath)) console.log(FIRST_BOOT);
  if (hidden) console.log(await hidden ? 'Sandbox running headless. Open the window: sbx-show   Attach here: sandbox claude -t' : 'Could not find the sandbox window to hide (it may still be starting); run sandbox hide in a moment.');
  else console.log('Sandbox starting. ' + run.harnessName + ' opens in Windows Terminal inside it. Attach here any time: sandbox claude -t');
  return 0;
};
