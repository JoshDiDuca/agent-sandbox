// `launch` / `generate`, and what sandbox claude runs: start a sandbox, or another session in the running one. From a
// folder the running sandbox does not have yet, the folder joins it (no restart) when it can, and otherwise a
// restart that adds it is offered (restart.ts).
import path from 'node:path';
import fs from 'node:fs';
import { select } from '@inquirer/prompts';
import { activateAccount, activeAccount, defaultAccount } from '../../host/accounts.js';
import { attachTerminal, findUnwatchedSession } from '../../host/attach.js';
import { requestSession, resetRunDir, waitForReady, waitForSession } from '../../host/channel.js';
import { describePrune, pruneStorage } from '../../host/cleanup.js';
import { generateSandbox } from '../../host/generate.js';
import { findSecretFiles } from '../../host/secrets.js';
import { checkRepo, saveRepoSnapshot } from '../../host/repo-guard.js';
import { assertCanLaunch, insideSandbox, isSandboxRunning, probeHost, spawnDetached, startSandbox } from '../../host/platform.js';
import { NeedsRestart, rememberProject, startRegistry } from '../../host/projects.js';
import { ensureTerminal } from '../../host/terminal.js';
import { hideSandboxWindow, showSandboxWindow } from '../../host/window.js';
import { readSandboxStatus } from '../../shared/rundir.js';
import { isWithin } from '../../shared/projects.js';
import { syncBeforeLaunch, watcherRunning } from '../../sync/watcher.js';
import type { Config, ResolvedRun, SandboxStatus, SessionStatus } from '../../core/types.js';
import { protectionsOf } from '../../core/project-policy.js';
import { assertSafeMapping, assertSafeWorkspace } from '../../core/safe-paths.js';
import { errMsg, fail, isRootPath, sleep } from '../../core/util.js';
import { syncAgentCommands } from './agent-commands.js';
import { askYesNo } from '../../core/prompt.js';
import { resolveRun } from '../../core/workspace.js';
import { c } from '../colors.js';
import { working } from '../progress.js';
import { requireOnPc, sandboxAlive, table, type Context } from './context.js';
import _ from 'lodash';
import { hereDir, joinHere, readyHere, type Joined } from './project.js';
import { offerRestart } from './restart.js';
import { addToList, setSetting } from './user-config.js';

/** Attaches this terminal; with attach.autoHide the sandbox window hides meanwhile (best effort, never fails the attach). */
export const attachHere = (ctx: Context, session: Parameters<typeof attachTerminal>[0]): Promise<number> => {
  if (ctx.loaded.config.attach.autoHide && !insideSandbox()) void hideSandboxWindow(ctx.storageRoot, 120).catch(() => false);
  return attachTerminal(session);
};

/** Nothing has been installed into this data set yet: the first start downloads every toolchain once. */
const firstBoot = (dataPath: string): boolean => !fs.existsSync(path.join(dataPath, 'tools', 'resolved-versions.json'));
const FIRST_BOOT = 'First start for this storage: the sandbox downloads and installs the toolchains, databases and agent this project needs.\n' +
  'That takes a few minutes, once. Everything is kept, so every later start reuses it and takes seconds.';

/** The sandbox writes sandbox.json a few seconds into its boot; a second launch right after the first waits for it. */
export const runningSandboxStatus = async (dataPath: string): Promise<SandboxStatus> => {
  for (let i = 0; i < 60; i++) {
    const status = readSandboxStatus(dataPath);
    if (status) return status;
    await sleep(1000);
  }
  return fail('A Windows Sandbox is running that this tool did not start (or that uses another storage.dataName).', 'Close that sandbox window first, then run sandbox claude again.');
};

/** Waits for the boot with its current step on a spinner (plain lines without a terminal). */
export const waitForBoot = (dataPath: string, launchId: string | null): Promise<SandboxStatus> => {
  let step = 'starting Windows Sandbox';
  return working(() => 'Waiting for the sandbox: ' + step, () => waitForReady(dataPath, launchId, sandboxAlive, (m) => { step = m; }));
};

/** The running sandbox, once it is ready. */
export const readySandbox = async (dataPath: string): Promise<SandboxStatus> => {
  const status = await runningSandboxStatus(dataPath);
  return status.phase === 'ready' ? status : waitForBoot(dataPath, status.launchId);
};

/** Waits for a session to start (its project's setup, the agent's install) with its progress on a spinner. */
const waitForStart = (ctx: Context, requestId: string, what: string): Promise<SessionStatus> => {
  let step = 'starting';
  return working(() => what + ': ' + step, () => waitForSession(ctx.dataPath, requestId, sandboxAlive, 60 * 60 * 1000, (m) => { step = m; }));
};

/**
 * Starts (or picks back up) a session in the folder `joined` describes. attach: show it in this terminal.
 * Exported for restart.ts, which reopens the sessions a restart ended.
 */
export const openSession = async (ctx: Context, ready: SandboxStatus, joined: Joined, o: { attach: boolean; harness?: string; args?: string[]; reuse?: boolean }): Promise<number> => {
  const { options, loaded, dataPath } = ctx;
  const cwd = joined.guestDir;
  const harness = o.harness ?? options.harness ?? joined.harness ?? loaded.config.defaultHarness;
  const args = o.args ?? options.passthrough;
  // -t with nothing new for the agent: pick up this folder's session if no terminal on this PC shows it (its tab was
  // closed, or you detached). Someone already attached, --new, or agent arguments: a new session, as before.
  const reuse = (o.reuse ?? true) && o.attach && !options.newSession && args.length === 0 && loaded.config.attach.reuseSession;
  const existing = reuse ? await findUnwatchedSession(dataPath, harness, cwd) : null;
  if (existing) {
    console.log('Reattaching to ' + harness + ' session ' + existing.id + ' in ' + cwd + ' (no other terminal is attached; --new starts another).');
    return attachHere(ctx, existing);
  }
  console.log(joined.spec
    ? 'Starting ' + harness + ' for ' + joined.project?.host + ' in the running sandbox (' + cwd + '; the first time sets up what it needs).'
    : 'Sandbox already running: starting another ' + harness + ' session in ' + cwd);
  // The agent's definition goes along: the sandbox may have booted with another agent.
  const harnessSpec = loaded.config.harnesses[harness];
  const requestId = requestSession(dataPath, harness, args, cwd, { ...(joined.spec ? { project: joined.spec } : {}), ...(harnessSpec ? { harnessSpec } : {}) });
  const session = await waitForStart(ctx, requestId, 'Starting ' + harness + ' in ' + cwd);
  if (o.attach) return attachHere(ctx, session);
  console.log('Session ' + session.id + ' opened in a new tab inside the sandbox. Attach here with: sandbox attach ' + session.id + (ready.headless ? '   (headless: sbx-show opens the window)' : ''));
  return 0;
};

/** The sessions a launch asks for: each --session, else one (the agent, in this folder). */
const wantedSessions = (ctx: Context): { harness?: string; folder: string }[] =>
  ctx.options.sessions.length ? ctx.options.sessions : [{ harness: ctx.options.harness, folder: hereDir(ctx) }];

/** The same command, for one of its sessions (its folder and agent). */
const contextFor = (ctx: Context, want: { harness?: string; folder: string }): Context =>
  ({ ...ctx, options: { ...ctx.options, workspace: want.folder, harness: want.harness, sessions: [] } });

/** Several sessions at once: all requested together (projects set up in parallel), then listed; -t attaches the first. */
const openSessions = async (ctx: Context, ready: SandboxStatus, list: { ctx: Context; joined: Joined }[]): Promise<number> => {
  const { dataPath, loaded, options } = ctx;
  const requests = list.map(({ ctx: at, joined }) => {
    const harness = at.options.harness ?? joined.harness ?? loaded.config.defaultHarness;
    const harnessSpec = loaded.config.harnesses[harness];
    const id = requestSession(dataPath, harness, options.passthrough, joined.guestDir, { ...(joined.spec ? { project: joined.spec } : {}), ...(harnessSpec ? { harnessSpec } : {}) });
    return { id, harness, folder: at.options.workspace ?? joined.guestDir, cwd: joined.guestDir };
  });
  let started = 0;
  const results = await working(() => 'Starting ' + requests.length + ' sessions (' + started + ' running)', () => Promise.allSettled(requests.map(async (r) => {
    const s = await waitForSession(dataPath, r.id, sandboxAlive, 60 * 60 * 1000, () => undefined);
    started++;
    return s;
  })));
  table([['SESSION', 'AGENT', 'FOLDER', ''], ...requests.map((r, i) => {
    const result = results[i];
    return [r.id, r.harness, r.folder, result.status === 'fulfilled' ? 'running   sandbox attach ' + r.id : c.red('FAILED: ' + errMsg(result.reason))];
  })]);
  const first = results.find((r): r is PromiseFulfilledResult<SessionStatus> => r.status === 'fulfilled');
  if (options.terminal && first) return attachHere(ctx, first.value);
  if (!first) return 1;
  console.log('Each has its own tab inside the sandbox' + (ready.headless ? ' (headless: sbx-show opens the window)' : '') + '. Attach to any of them, from any terminal: sandbox attach');
  return results.every((r) => r.status === 'fulfilled') ? 0 : 1;
};

/** A sandbox is already running: open the sessions in it (new tabs inside; optionally attach here). */
const launchIntoRunning = async (ctx: Context): Promise<number> => {
  const ready = await readySandbox(ctx.dataPath);
  const wants = wantedSessions(ctx);
  // Every folder joins first: when one needs a restart, nothing has been started that the restart would end.
  const joined: { ctx: Context; joined: Joined }[] = [];
  const needs: NeedsRestart[] = [];
  for (const want of wants) {
    const at = ctx.options.sessions.length ? contextFor(ctx, want) : ctx;
    try { joined.push({ ctx: at, joined: await joinHere(at, ready) }); } catch (e) {
      if (!(e instanceof NeedsRestart)) throw e;
      if (!needs.some((n) => n.hostDir.toLowerCase() === e.hostDir.toLowerCase())) needs.push(e);
    }
  }
  if (needs.length) return offerRestart(ctx, needs, () => launchIntoRunning(ctx));
  for (const note of _.uniq(joined.flatMap((j) => j.joined.notes))) console.log(note);
  if (joined.length === 1) return openSession(joined[0].ctx, ready, joined[0].joined, { attach: ctx.options.terminal });
  return openSessions(ctx, ready, joined);
};

/** `sandbox start` while one runs: this folder joins it (set up, no agent), or a restart that adds it is offered. */
const startIntoRunning = async (ctx: Context): Promise<number> => {
  const ready = await readySandbox(ctx.dataPath);
  let joined: Joined;
  try { joined = await readyHere(ctx, ready); } catch (e) {
    if (e instanceof NeedsRestart) return offerRestart(ctx, [e], () => startIntoRunning(ctx));
    throw e;
  }
  const where = joined.spec ? ' This folder is ready in it as ' + joined.guestDir + ' (sbx-shell ' + joined.spec.name + ' opens a terminal there inside).' : '';
  console.log('A sandbox is already running' + (showSandboxWindow(ctx.storageRoot) ? '; its window is in front now.' : '.') + where + ' Start an agent in it with sandbox claude (or sandbox <agent>); stop it with sandbox stop.');
  return 0;
};

const syncSummary = (config: Config, dataPath: string, workspaceHost: string): string => {
  try {
    const s = syncBeforeLaunch(config, dataPath, workspaceHost);
    return s.history + ' file(s) of history in, claude-mem ' + s.claudeMem;
  } catch (e) { return 'FAILED: ' + errMsg(e); }
};

/**
 * Asked once per parent folder: map it at every start (a project root), so the projects next to this one open in the
 * running sandbox without a restart. The answer is saved to your config.
 */
const maybeAddRoot = async (ctx: Context, run: ResolvedRun): Promise<void> => {
  const { projects } = run.config;
  const parent = path.dirname(run.workspaceHost);
  if (!projects.askToAddRoot || ctx.options.yes || !process.stdin.isTTY || !process.stdout.isTTY) return;
  if (projects.roots.some((r) => isWithin(r, run.workspaceHost)) || projects.declinedRoots.some((d) => isWithin(d, parent) && isWithin(parent, d))) return;
  if (isRootPath(parent)) return;
  try { assertSafeWorkspace(parent, ctx.packageRoot, run.storageRoot); assertSafeMapping(parent, ctx.packageRoot, run.storageRoot); } catch { return; }
  const answer = await select({
    message: 'Map ' + parent + ' at every start, so other projects there (also new ones) open in the running sandbox without a restart? Agents in the sandbox can then see every project in it.',
    choices: [
      { name: 'Yes, from now on', value: 'yes' },
      { name: 'No (and do not ask again for this folder)', value: 'no' },
      { name: 'Never ask this again', value: 'never' },
    ],
  });
  if (answer === 'yes') { addToList(ctx, ['projects', 'roots'], parent); run.config.projects.roots.push(parent); console.log('Added ' + parent + ' to projects.roots (sandbox projects roots remove ' + parent + ' undoes it).'); }
  if (answer === 'no') addToList(ctx, ['projects', 'declinedRoots'], parent);
  if (answer === 'never') setSetting(ctx, ['projects', 'askToAddRoot'], false);
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
  if (guarded.length) console.warn(c.yellow('SECURITY: neutralised ' + guarded.length + ' change(s) the last sandbox made that could run code on this PC (see sandbox status).'));
  resetRunDir(dataPath);
  return { account, terminal: terminal.message, history, pruned: describePrune(pruneStorage(storageRoot)) };
};

/** A restart that adds a project: map these too, start no session at boot (restart.ts opens them), wait until ready. */
export interface LaunchExtras { extraProjects?: string[]; autoSession?: boolean; waitUntilReady?: boolean }

export const launch = async (ctx: Context, generateOnly = false, extras: LaunchExtras = {}): Promise<number> => {
  const { options, loaded, packageRoot, dataPath, storageRoot } = ctx;
  // attach.auto: an agent started from an interactive terminal attaches it, as with -t.
  if (loaded.config.attach.auto && !options.noAgent && process.stdin.isTTY && process.stdout.isTTY) options.terminal = true;
  if (!generateOnly) requireOnPc('launch');
  // agentCommands (Beta) follows the config: a setting changed in the file takes effect here too. Never blocks a launch.
  if (!generateOnly) { try { syncAgentCommands(ctx, loaded.config); } catch (e) { console.warn('Agent commands (Beta): ' + errMsg(e)); } }
  if (!generateOnly && isSandboxRunning()) return options.noAgent ? startIntoRunning(ctx) : launchIntoRunning(ctx);
  // Several sessions: the sandbox starts from the first one's folder with the others' folders mapped too, then
  // they all open in it (each project is set up on demand, in parallel). One --session is an ordinary launch.
  const wants = options.sessions;
  if (wants.length === 1) return launch(contextFor(ctx, wants[0]), generateOnly, extras);
  if (wants.length > 1) {
    const first = contextFor(ctx, wants[0]);
    const others = _.uniqBy(wants.slice(1).map((w) => w.folder).filter((f) => !isWithin(wants[0].folder, f)), (f) => f.toLowerCase());
    const started = await launch({ ...first, options: { ...first.options, terminal: false } }, generateOnly, { ...extras, extraProjects: [...(extras.extraProjects ?? []), ...others], autoSession: false, waitUntilReady: true });
    return generateOnly || started !== 0 ? started : launchIntoRunning(ctx);
  }
  const run = await resolveRun({
    packageRoot, loaded, cwd: process.cwd(), workspace: options.workspace, harness: options.harness, noAgent: options.noAgent,
    noLocalConfig: options.noLocalConfig, trustConfig: options.trustConfig, scripts: options.scripts, databases: options.databases, headless: options.headless,
    nodeVersion: options.node, pythonVersion: options.python, ask: askYesNo,
  });
  const { config } = run;
  if (!generateOnly) assertCanLaunch();
  if (!generateOnly && !extras.extraProjects) await maybeAddRoot(ctx, run);
  const prepared = generateOnly ? null : await prepare(ctx, run);
  const generated = generateSandbox({ packageRoot, run, harnessArgs: options.passthrough, probe: probeHost(config, run.harnessName), extraProjects: extras.extraProjects, autoSession: extras.autoSession });

  for (const note of [...run.notes, ...generated.projects.notes]) console.log(note);
  const secretFiles = config.secrets.warnFiles ? findSecretFiles(run.workspaceHost) : [];
  if (secretFiles.length) {
    const shown = secretFiles.slice(0, 12).join(', ') + (secretFiles.length > 12 ? ', ...' : '');
    console.warn(c.yellow('Heads-up: the agent can read these files in your workspace, which often hold secrets: ' + shown + '. Move real credentials out of the folder (or use test ones). Silence with secrets.warnFiles = false.'));
  }
  const { roots, projects } = generated.projects;
  table([
    ['Workspace', run.workspaceHost + '  ->  ' + config.guestWorkspace + (config.readOnly ? '  (read-only)' : '')],
    ['Agent', run.harnessName + (prepared?.account ? '  (account: ' + prepared.account + ')' : '') + '   Memory: ' + generated.memoryMb + ' MB   Network: ' + config.sandbox.networking + (config.sandbox.headless ? '   HEADLESS' : '')],
    ['Node', run.versions.node.spec + ' (' + run.versions.node.source + ')   Python: ' + run.versions.python.spec + ' (' + run.versions.python.source + ')'],
    ...(prepared ? [['Terminal', prepared.terminal], ['History', prepared.history], ['Cleanup', prepared.pruned]] : []),
    ['Toolchains', Object.entries(generated.toolchains).filter(([, d]) => d.on).map(([name, d]) => name + ' (' + d.reason + ')').join(', ') || 'Node only (nothing else used by this project)'],
    ...(generated.databases.length
      ? generated.databases.map((d, i) => [i ? '' : 'Databases', d.database + (d.database === 'sqlserver' ? ' (cannot run in the sandbox; use Postgres or SQLite for local work)' : ' on port ' + d.port) + '  because ' + d.reasons[0] + (d.reasons.length > 1 ? ' (+' + (d.reasons.length - 1) + ' more)' : '')])
      : [['Databases', 'none needed (databases.<name>.enabled = true adds one)']]),
    ['Desktop', generated.personalization],
    ['Claude', generated.profile.staged.length ? generated.profile.staged.join(', ') + (generated.profile.credentials ? '  (INCLUDING YOUR LOGIN)' : '') : 'no settings copied'],
    ['Secrets', !config.secrets.strip ? 'NOT stripped (secrets.strip is off)' : generated.profile.secretsRemoved.length ? 'kept on this PC: ' + generated.profile.secretsRemoved.join(', ') + '  (secrets.allow lets one through)' : 'none found in what is copied'],
    ...roots.map((r, i) => [i ? '' : 'Project roots', r.host + '  ->  ' + r.guest + '  (every project in it opens without a restart)']),
    ...projects.map((p, i) => [i ? '' : 'Projects', p.host + '  ->  ' + p.guest]),
    ...generated.mappings.slice(3).filter((m) => ![...roots, ...projects].some((p) => p.guest === m.guest)).map((m) => ['  map ' + (m.readOnly ? 'ro' : 'rw'), m.host + '  ->  ' + m.guest]),
    ['Generated', generated.wsbPath],
  ]);
  if (generateOnly) return 0;

  // Every folder the sandbox can write is snapshotted before it starts (the guard compares against this), and the
  // projects it starts with are recorded host-side for the commands that run later.
  saveRepoSnapshot(dataPath, run.workspaceHost, projects.map((p) => p.host), roots.map((r) => r.host));
  startRegistry(storageRoot, { launchId: generated.launchId, protections: protectionsOf(config), primary: { host: run.workspaceHost, guest: config.guestWorkspace }, roots, boot: projects });
  rememberProject(storageRoot, run.workspaceHost);
  startSandbox(generated.wsbPath);
  // Absolute: the watcher runs from another folder, and a relative --config there would make it exit silently.
  if (!watcherRunning(dataPath)) spawnDetached(ctx.entry, ['_watch', ...(options.config ? ['--config', path.resolve(options.config)] : [])]);
  // Hiding runs alongside; a failure to find the window must never break the launch or an attach.
  const hidden = config.sandbox.headless ? hideSandboxWindow(storageRoot).catch(() => false) : null;
  if (options.terminal || options.noAgent || extras.waitUntilReady) {
    if (firstBoot(dataPath)) console.log(FIRST_BOOT);
    await waitForBoot(dataPath, generated.launchId);
    if (extras.waitUntilReady) return 0;
    // Without an agent there is no session to attach to: the sandbox itself is the result.
    if (options.noAgent) { console.log('Sandbox ready. Its window has a terminal in ' + config.guestWorkspace + '; from here: sandbox exec -- <command>, sandbox stop.'); return 0; }
    return attachHere(ctx, await waitForStart(ctx, generated.launchId, 'Starting ' + run.harnessName));
  }
  if (firstBoot(dataPath)) console.log(FIRST_BOOT);
  if (hidden) console.log(await hidden ? 'Sandbox running headless. Open the window: sbx-show   Attach here: sandbox claude -t' : 'Could not find the sandbox window to hide (it may still be starting); run sandbox hide in a moment.');
  else console.log('Sandbox starting. ' + run.harnessName + ' opens in Windows Terminal inside it. Attach here any time: sandbox claude -t');
  return 0;
};
