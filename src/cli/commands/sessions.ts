// Working with a running sandbox: attach, sessions, status, exec, restart, stop, show/hide.
import _ from 'lodash';
import type { SessionStatus } from '../../core/types.js';
import { activeAccount } from '../../host/accounts.js';
import { execInSandbox, pickSession, pingSandbox, restartSessions, currentSessions, runningSessions, sessionViewers, waitForReady } from '../../host/channel.js';
import type { Viewers } from '../../shared/pty-client.js';
import { isSandboxRunning } from '../../host/platform.js';
import { repoFindings } from '../../host/repo-guard.js';
import { hideSandboxWindow, showSandboxWindow } from '../../host/window.js';
import { listSessions, readSandboxStatus } from '../../shared/rundir.js';
import { watcherRunning } from '../../sync/watcher.js';
import { errMsg, fail, safeText, sleep } from '../../core/util.js';
import { currentGuestDir, printJson, requireRunning, sandboxAlive, table, type Context } from './context.js';
import { attachHere } from './launch.js';

export const attach = async (ctx: Context): Promise<number> => {
  requireRunning('Start one with: sandbox claude --terminal');
  await waitForReady(ctx.dataPath, null, sandboxAlive);
  const id = ctx.options.positionals[0];
  if (!id && runningSessions(ctx.dataPath).length === 0) await sleep(1500);
  return attachHere(ctx, pickSession(ctx.dataPath, id));
};

type Listed = SessionStatus & { viewers?: Viewers | null };

const viewerText = (v: Viewers | null | undefined): string => (v === undefined ? '-' : v === null ? 'unknown (older session)' : v.remote + ' here, ' + (v.viewers - v.remote) + ' in sandbox');
// harness, cwd and times are written by the sandbox: printed through safeText.
const sessionRow = (s: Listed): string[] => [s.id, safeText(s.harness), s.phase + (s.exitCode !== undefined ? ' (' + s.exitCode + ')' : ''), viewerText(s.viewers), safeText(s.cwd), safeText(new Date(s.startedAt).toLocaleTimeString())];

export const sessions = async (ctx: Context): Promise<number> => {
  // Who is attached comes from each session itself, so a terminal that was closed is never counted.
  const live = isSandboxRunning();
  // Only this sandbox's sessions are asked (and at most MAX_QUERIED_SESSIONS): the sandbox writes these files.
  const ask = new Set(live ? currentSessions(ctx.dataPath).map((s) => s.id) : []);
  const list: Listed[] = await Promise.all(listSessions(ctx.dataPath).map(async (s) => (ask.has(s.id) ? { ...s, viewers: await sessionViewers(s) } : s)));
  if (printJson(ctx, list.map((s) => _.omit(s, 'attach')))) return 0;
  if (list.length === 0) console.log('No sessions.');
  else table([['ID', 'AGENT', 'STATE', 'ATTACHED', 'FOLDER', 'STARTED'], ...list.map(sessionRow)]);
  return 0;
};

export const status = async (ctx: Context): Promise<number> => {
  const running = isSandboxRunning();
  const sandbox = readSandboxStatus(ctx.dataPath);
  const findings = repoFindings(ctx.dataPath);
  const daemon = running && sandbox?.phase === 'ready' ? await pingSandbox(ctx.dataPath, sandboxAlive).then((r) => r.message, (e: unknown) => 'no answer (' + errMsg(e) + ')') : '-';
  const info = {
    running, phase: running ? sandbox?.phase ?? 'unknown' : 'stopped', message: sandbox?.message, workspace: sandbox?.workspaceHost, headless: sandbox?.headless,
    daemon, account: activeAccount(ctx.dataPath), sessions: running ? runningSessions(ctx.dataPath).length : 0, syncWatcher: watcherRunning(ctx.dataPath),
    repoGuard: findings.length ? findings.map((x) => x.kind + ': ' + x.detail).join('; ') : 'nothing from the sandbox needed neutralising',
  };
  if (!printJson(ctx, info)) table(Object.entries(info).map(([k, v]) => [_.startCase(k), safeText(String(v ?? '-'))]));
  return 0;
};

export const exec = async (ctx: Context): Promise<number> => {
  const command = [...ctx.options.positionals, ...ctx.options.passthrough];
  if (command.length === 0) fail('No command given.', 'Usage: sandbox exec [--timeout <s>] -- <command> [args...]');
  requireRunning();
  const ready = await waitForReady(ctx.dataPath, null, sandboxAlive);
  const result = await execInSandbox(ctx.dataPath, command, currentGuestDir(ctx, ready.workspaceHost, ready.guestWorkspace), ctx.options.timeout, sandboxAlive);
  if (!printJson(ctx, result)) {
    if (result.stdout) process.stdout.write(safeText(result.stdout));
    if (result.stderr) process.stderr.write(safeText(result.stderr));
    if (!result.ok && !result.stdout && !result.stderr) console.error(result.message);
  }
  return result.exitCode ?? 1;
};

/** `sandbox db`: runs the sandbox's own `sbx-db`, which knows this project's database versions and ports. */
export const db = async (ctx: Context): Promise<number> => {
  const [action = 'list', name] = ctx.options.positionals;
  if (action !== 'list' && !name) fail('Which database?', 'Usage: sandbox db ' + action + ' <postgres|mysql|mongodb|redis|dynamodb>');
  requireRunning('Start one with: sandbox start --database <name>');
  const ready = await waitForReady(ctx.dataPath, null, sandboxAlive);
  // Starting can download the database the first time.
  const result = await execInSandbox(ctx.dataPath, ['sbx-db', action, ...(name ? [name] : [])], ready.guestWorkspace, 1800, sandboxAlive);
  if (result.stdout) process.stdout.write(safeText(result.stdout));
  if (result.stderr) process.stderr.write(safeText(result.stderr));
  if (!result.ok && !result.stdout && !result.stderr) console.error(result.message);
  return result.exitCode ?? 1;
};

export const restart = async (ctx: Context): Promise<number> => {
  requireRunning();
  console.log((await restartSessions(ctx.dataPath, ctx.options.harness ?? null, sandboxAlive)).message);
  return 0;
};

export const stop = async (ctx: Context): Promise<number> => {
  if (!isSandboxRunning()) { console.log('No Windows Sandbox is running.'); return 0; }
  const sandbox = readSandboxStatus(ctx.dataPath) ?? fail('This sandbox was not started by this tool.', 'Close its window instead.');
  await execInSandbox(ctx.dataPath, ['C:\\Windows\\System32\\shutdown.exe', '/s', '/t', '2'], sandbox.guestWorkspace, 30, sandboxAlive);
  console.log('Sandbox is shutting down; history and claude-mem sync back when it closes.');
  return 0;
};

export const show = (ctx: Context): number => {
  requireRunning();
  if (!showSandboxWindow(ctx.storageRoot)) fail('Could not find the Windows Sandbox window.', 'It may still be starting; try again in a few seconds.');
  return 0;
};

export const hide = async (ctx: Context): Promise<number> => {
  requireRunning();
  if (!(await hideSandboxWindow(ctx.storageRoot, 5))) fail('Could not find a visible Windows Sandbox window.', 'It may already be hidden (sbx-show brings it back).');
  console.log('Sandbox window hidden. Bring it back with: sbx-show');
  return 0;
};
