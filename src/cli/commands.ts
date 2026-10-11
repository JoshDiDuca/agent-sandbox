import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import type { CliOptions } from './args.js';
import type { LoadedConfig, SessionStatus } from '../core/types.js';
import { activateAccount, activeAccount, defaultAccount, listAccounts, removeAccount, saveAccount, setDefaultAccount } from '../host/accounts.js';
import { attachTerminal, execInSandbox, pickSession, pingSandbox, requestSession, resetRunDir, restartSessions, runningSessions, waitForReady, waitForSession } from '../host/channel.js';
import { DEFAULTS, loadConfig, userConfigPath, userDir } from '../core/config.js';
import { listSessions, readSandboxStatus } from '../shared/rundir.js';
import { describePrune, pruneStorage } from '../host/cleanup.js';
import { assertCanLaunch, doctorRows, hostClaude, isSandboxRunning, probeHost, spawnDetached, startSandbox } from '../host/platform.js';
import { hostClaudeDir } from '../host/claude-profile.js';
import { generateSandbox } from '../host/generate.js';
import { syncBack, syncBeforeLaunch, watch, watcherRunning } from '../sync/watcher.js';
import { ensureTerminal } from '../host/terminal.js';
import { errMsg, expandPath, fail, isInsideOrEqual, sleep, writeJson } from '../core/util.js';
import { hideSandboxWindow, showSandboxWindow } from '../host/window.js';
import { askYesNo, resolveRun } from '../core/workspace.js';

export interface Context { packageRoot: string; entry: string; options: CliOptions; loaded: LoadedConfig; storageRoot: string; dataPath: string }

export const createContext = (packageRoot: string, entry: string, options: CliOptions): Context => {
  const loaded = loadConfig(options.config);
  const storageRoot = expandPath(loaded.config.storage.root, loaded.base);
  return { packageRoot, entry, options, loaded, storageRoot, dataPath: path.join(storageRoot, 'data', loaded.config.storage.dataName) };
};

const table = (rows: string[][]): void => {
  const widths = _.range(_.max(rows.map((r) => r.length)) ?? 0).map((i) => _.max(rows.map((r) => (r[i] ?? '').length)) ?? 0);
  for (const row of rows) console.log(row.map((cell, i) => (i === row.length - 1 ? cell : _.padEnd(cell, widths[i] + 2))).join(''));
};

const sandboxAlive = (): boolean => isSandboxRunning();

/** Maps a folder on this PC to its path inside the running sandbox (only folders inside the mapped workspace exist there). */
const guestPathFor = (hostDir: string, workspaceHost: string, guestWorkspace: string): string => {
  if (!isInsideOrEqual(workspaceHost, hostDir)) fail('The running sandbox maps ' + workspaceHost + ', and Windows Sandbox cannot add folders while running. Run from inside that folder, or close the sandbox and launch again from ' + hostDir + '.');
  const rel = path.relative(workspaceHost, hostDir);
  return rel ? path.win32.join(guestWorkspace, rel) : guestWorkspace;
};

// ---- launch -------------------------------------------------------------------------------------------------------

/** Another agent session in the sandbox that is already running (new tab inside it; optionally attach here). */
const launchIntoRunning = async (ctx: Context): Promise<number> => {
  const { options, loaded, dataPath } = ctx;
  const status = readSandboxStatus(dataPath) ?? fail('A Windows Sandbox is running but was not started by agent-sandbox (or uses another storage.dataName). Close it first.');
  const ready = status.phase === 'ready' ? status : await waitForReady(dataPath, status.launchId, sandboxAlive);
  const cwd = guestPathFor(path.resolve(options.workspace ?? process.cwd()), ready.workspaceHost, ready.guestWorkspace);
  const harness = options.harness ?? loaded.config.defaultHarness;
  console.log('Sandbox already running: starting another ' + harness + ' session in ' + cwd);
  const session = await waitForSession(dataPath, requestSession(dataPath, harness, options.passthrough, cwd), sandboxAlive);
  if (options.terminal) return attachTerminal(session);
  console.log('Session ' + session.id + ' opened in a new tab inside the sandbox. Attach here with: agent-sandbox attach ' + session.id + (ready.headless ? '   (headless: sbx-show opens the window)' : ''));
  return 0;
};

export const launch = async (ctx: Context, generateOnly = false): Promise<number> => {
  const { options, loaded, packageRoot, dataPath, storageRoot } = ctx;
  if (!generateOnly && isSandboxRunning()) return launchIntoRunning(ctx);
  const run = await resolveRun({ packageRoot, loaded, cwd: process.cwd(), workspace: options.workspace, harness: options.harness, noAgent: options.noAgent, noLocalConfig: options.noLocalConfig, trustConfig: options.trustConfig, scripts: options.scripts, headless: options.headless, nodeVersion: options.node, pythonVersion: options.python, ask: askYesNo });
  const { config } = run;
  if (!generateOnly) assertCanLaunch();

  const account = options.account ?? defaultAccount(storageRoot);
  if (account && run.harnessName === 'claude' && account !== activeAccount(dataPath)) activateAccount(storageRoot, dataPath, account);
  const terminal = config.provisioning.terminal.enabled ? await ensureTerminal(dataPath, config.provisioning.refresh) : { exe: null, message: 'disabled' };
  let synced = 'disabled';
  try { const s = syncBeforeLaunch(config, dataPath, run.workspaceHost); synced = s.history + ' file(s) of history in, claude-mem ' + s.claudeMem; } catch (e) { synced = 'FAILED: ' + errMsg(e); }
  resetRunDir(dataPath);
  const pruned = describePrune(pruneStorage(storageRoot));
  const probe = probeHost(config, run.harnessName);
  const generated = generateSandbox({ packageRoot, run, harnessArgs: options.passthrough, probe });

  for (const note of run.notes) console.log(note);
  table([
    ['Workspace', run.workspaceHost + '  ->  ' + config.guestWorkspace + (config.readOnly ? '  (read-only)' : '')],
    ['Agent', run.harnessName + (account ? '  (account: ' + account + ')' : '') + '   Memory: ' + generated.memoryMb + ' MB   Network: ' + config.sandbox.networking + (config.sandbox.headless ? '   HEADLESS' : '')],
    ['Node', run.versions.node.spec + ' (' + run.versions.node.source + ')   Python: ' + run.versions.python.spec + ' (' + run.versions.python.source + ')'],
    ['Terminal', terminal.message],
    ['History', synced],
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

// ---- sessions -----------------------------------------------------------------------------------------------------

export const attach = async (ctx: Context): Promise<number> => {
  if (!isSandboxRunning()) fail('No Windows Sandbox is running. Start one with: claude-sbx --terminal');
  await waitForReady(ctx.dataPath, null, sandboxAlive);
  const id = ctx.options.positionals[0];
  if (!id && runningSessions(ctx.dataPath).length === 0) await sleep(1500);
  return attachTerminal(pickSession(ctx.dataPath, id));
};

const describeSession = (s: SessionStatus): string[] => [s.id, s.harness, s.phase + (s.exitCode !== undefined ? ' (' + s.exitCode + ')' : ''), s.cwd, new Date(s.startedAt).toLocaleTimeString()];

export const sessions = (ctx: Context): number => {
  const list = listSessions(ctx.dataPath);
  if (ctx.options.json) { console.log(JSON.stringify(list, null, 2)); return 0; }
  if (list.length === 0) { console.log('No sessions.'); return 0; }
  table([['ID', 'AGENT', 'STATE', 'FOLDER', 'STARTED'], ...list.map(describeSession)]);
  return 0;
};

export const status = async (ctx: Context): Promise<number> => {
  const running = isSandboxRunning();
  const sandbox = readSandboxStatus(ctx.dataPath);
  const live = running && sandbox?.phase === 'ready' ? await pingSandbox(ctx.dataPath, sandboxAlive).then((r) => r.message, (e: unknown) => 'no answer (' + errMsg(e) + ')') : '-';
  const info = { running, phase: running ? sandbox?.phase ?? 'unknown' : 'stopped', message: sandbox?.message, workspace: sandbox?.workspaceHost, headless: sandbox?.headless, daemon: live, account: activeAccount(ctx.dataPath), sessions: running ? runningSessions(ctx.dataPath).length : 0, syncWatcher: watcherRunning(ctx.dataPath) };
  if (ctx.options.json) { console.log(JSON.stringify(info, null, 2)); return 0; }
  table(Object.entries(info).map(([k, v]) => [_.startCase(k), String(v ?? '-')]));
  return 0;
};

export const exec = async (ctx: Context): Promise<number> => {
  const command = [...ctx.options.positionals, ...ctx.options.passthrough];
  if (command.length === 0) fail('Usage: agent-sandbox exec [--timeout <s>] -- <command> [args...]');
  if (!isSandboxRunning()) fail('No Windows Sandbox is running.');
  const ready = await waitForReady(ctx.dataPath, null, sandboxAlive);
  const cwd = guestPathFor(path.resolve(ctx.options.workspace ?? process.cwd()), ready.workspaceHost, ready.guestWorkspace);
  const result = await execInSandbox(ctx.dataPath, command, cwd, ctx.options.timeout, sandboxAlive);
  if (ctx.options.json) { console.log(JSON.stringify(result, null, 2)); return result.exitCode ?? 1; }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (!result.ok && !result.stdout && !result.stderr) console.error(result.message);
  return result.exitCode ?? 1;
};

export const restart = async (ctx: Context): Promise<number> => {
  if (!isSandboxRunning()) fail('No Windows Sandbox is running.');
  console.log((await restartSessions(ctx.dataPath, ctx.options.harness ?? null, sandboxAlive)).message);
  return 0;
};

export const stop = async (ctx: Context): Promise<number> => {
  if (!isSandboxRunning()) { console.log('No Windows Sandbox is running.'); return 0; }
  const ready = readSandboxStatus(ctx.dataPath) ?? fail('This sandbox was not started by agent-sandbox; close its window instead.');
  await execInSandbox(ctx.dataPath, ['shutdown', '/s', '/t', '2'], ready.guestWorkspace, 30, sandboxAlive);
  console.log('Sandbox is shutting down; history and claude-mem sync back when it closes.');
  return 0;
};

// ---- windows --------------------------------------------------------------------------------------------------------

export const show = (ctx: Context): number => {
  if (!isSandboxRunning()) fail('No Windows Sandbox is running.');
  if (!showSandboxWindow(ctx.storageRoot)) fail('Could not find the Windows Sandbox window.');
  return 0;
};

export const hide = async (ctx: Context): Promise<number> => {
  if (!isSandboxRunning()) fail('No Windows Sandbox is running.');
  if (!(await hideSandboxWindow(ctx.storageRoot, 5))) fail('Could not find a visible Windows Sandbox window.');
  console.log('Sandbox window hidden. Bring it back with: sbx-show');
  return 0;
};

// ---- accounts -------------------------------------------------------------------------------------------------------

export const account = async (ctx: Context): Promise<number> => {
  const { storageRoot, dataPath, options, loaded } = ctx;
  const [action = 'list', name] = options.positionals;
  const needName = (): string => name ?? fail('Usage: agent-sandbox account ' + action + ' <name>');
  switch (action) {
    case 'list': {
      const rows = listAccounts(storageRoot, dataPath);
      if (options.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      if (rows.length === 0) { console.log('No saved accounts. Sign in inside the sandbox, then: agent-sandbox account save <name>   (or --from-host to save this PC\'s login)'); return 0; }
      table([['', 'NAME', 'EMAIL', 'SAVED'], ...rows.map((a) => [(a.isActive ? '*' : ' ') + (a.isDefault ? 'D' : ' '), a.name, a.email ?? '-', a.savedAt.slice(0, 16).replace('T', ' ')])]);
      console.log('\n* = active in the sandbox   D = default for new launches');
      return 0;
    }
    case 'save': {
      const profile = loaded.config.claudeProfile;
      const fromHost = options.fromHost ? { claudeDir: hostClaudeDir(profile), globalStateFile: process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(path.dirname(hostClaudeDir(profile)), '.claude.json') } : null;
      const saved = saveAccount(storageRoot, dataPath, needName(), fromHost);
      console.log('Saved account "' + saved.name + '"' + (saved.email ? ' (' + saved.email + ')' : '') + '.');
      return 0;
    }
    case 'use': {
      const activated = activateAccount(storageRoot, dataPath, needName());
      console.log('Sandbox now uses "' + activated.name + '"' + (activated.email ? ' (' + activated.email + ')' : '') + '.');
      if (isSandboxRunning() && !options.noRestart && runningSessions(dataPath).some((s) => s.harness === 'claude')) {
        console.log((await restartSessions(dataPath, 'claude', sandboxAlive)).message + ' with --continue; the conversation carries on under the new account.');
      }
      return 0;
    }
    case 'default': setDefaultAccount(storageRoot, needName()); console.log('Default account: ' + name); return 0;
    case 'remove': removeAccount(storageRoot, needName()); console.log('Removed account ' + name); return 0;
    default: fail('Unknown account action "' + action + '" (list | save | use | default | remove)');
  }
};

// ---- maintenance ----------------------------------------------------------------------------------------------------

export const sync = (ctx: Context): number => {
  const result = syncBack(ctx.loaded.config, ctx.dataPath, !isSandboxRunning());
  console.log('History: ' + result.history + ' item(s) synced back. claude-mem: ' + result.claudeMem + (isSandboxRunning() ? ' (claude-mem syncs when the sandbox closes)' : ''));
  return 0;
};

export const logs = async (ctx: Context): Promise<number> => {
  const dir = path.join(ctx.dataPath, 'logs');
  const newest = fs.existsSync(dir) ? _.maxBy(fs.readdirSync(dir).filter((f) => /^(guest|daemon|bootstrap)-.*\.log$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })), 't') : undefined;
  if (!newest) fail('No logs yet in ' + dir);
  const file = path.join(dir, newest.f);
  console.log('== ' + file + ' ==');
  let size = 0;
  const print = (): void => { const text = fs.readFileSync(file, 'utf8'); process.stdout.write(size === 0 ? text.split('\n').slice(-120).join('\n') : text.slice(size)); size = text.length; };
  print();
  while (ctx.options.follow) { await sleep(1000); print(); }
  return 0;
};

export const clean = (ctx: Context): number => {
  const running = isSandboxRunning() ? readSandboxStatus(ctx.dataPath)?.launchId : undefined;
  console.log('Cleanup: ' + describePrune(pruneStorage(ctx.storageRoot, { launchDays: ctx.options.days, keep: running ? [running] : [] })));
  return 0;
};

export const config = (ctx: Context): number => {
  const [action = 'show'] = ctx.options.positionals;
  const file = userConfigPath();
  switch (action) {
    case 'path': console.log(ctx.loaded.configPath ?? file + '  (does not exist yet)'); return 0;
    case 'init': {
      if (fs.existsSync(file)) fail(file + ' already exists.');
      const example = path.join(ctx.packageRoot, 'config.example.json');
      if (fs.existsSync(example)) { fs.mkdirSync(userDir(), { recursive: true }); fs.copyFileSync(example, file); } else writeJson(file, DEFAULTS);
      fs.mkdirSync(path.join(userDir(), 'hooks', 'pre-agent'), { recursive: true });
      console.log('Created ' + file + ' (only keep the keys you change). Your own hooks go in ' + path.join(userDir(), 'hooks'));
      return 0;
    }
    case 'show': console.log(JSON.stringify(ctx.loaded.config, null, 2)); return 0;
    default: fail('Unknown config action "' + action + '" (show | path | init)');
  }
};

export const doctor = (ctx: Context): number => {
  table(doctorRows(ctx.loaded.config, ctx.options.harness ?? ctx.loaded.config.defaultHarness, ctx.storageRoot, ctx.loaded.configPath));
  return 0;
};

export const claudeHost = (ctx: Context): number => hostClaude(ctx.storageRoot, ctx.options.personal, ctx.options.passthrough);

export const watcher = (ctx: Context): Promise<void> => watch(ctx.loaded.config, ctx.dataPath);
