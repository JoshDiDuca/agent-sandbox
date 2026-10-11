// Working with a running sandbox: attach, sessions, status, exec, restart, stop, show/hide. Each knows which project
// you run it from (project.ts): attach and sessions put that project's sessions first, exec and db run in it, restart
// restarts its sessions, stop warns about the other projects' sessions.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { select } from '@inquirer/prompts';
import _ from 'lodash';
import type { GuestResponse, SessionStatus } from '../../core/types.js';
import { askYesNo } from '../../core/prompt.js';
import { activeAccount } from '../../host/accounts.js';
import { execInSandbox, pickSession, pingSandbox, restartSessions, currentSessions, runningSessions, sessionsFirstIn } from '../../host/channel.js';
import { sessionViewers } from '../../host/attach.js';
import type { Viewers } from '../../shared/pty-client.js';
import { insideSandbox, isSandboxRunning } from '../../host/platform.js';
import { NeedsRestart, readRegistry, type RegistryEntry } from '../../host/projects.js';
import { guardedProjects, repoFindings } from '../../host/repo-guard.js';
import { hideSandboxWindow, showSandboxWindow } from '../../host/window.js';
import { isWithin, projectForGuestDir } from '../../shared/projects.js';
import { listProjectStatus, listSessions, readSandboxStatus } from '../../shared/rundir.js';
import { watcherRunning } from '../../sync/watcher.js';
import { errMsg, fail, safeText, sleep } from '../../core/util.js';
import { printJson, requireOnPc, requireRunning, sandboxAlive, table, type Context } from './context.js';
import { attachHere, readySandbox } from './launch.js';
import { hereDir, joinHere, locateHere, provisionJoined } from './project.js';
import { working } from '../progress.js';
import { ago, c, shortenMiddle, termWidth } from '../colors.js';

const viewerText = (v: Viewers | null | undefined): string => (v === undefined ? '-' : v === null ? 'unknown (older session)' : v.remote + ' here, ' + (v.viewers - v.remote) + ' in sandbox');
const projectOf = (projects: RegistryEntry[], s: SessionStatus): string => s.project ?? projectForGuestDir(projects, s.cwd)?.name ?? '-';

export const attach = async (ctx: Context): Promise<number> => {
  requireOnPc('attach');
  requireRunning('Start one with: sandbox claude --terminal');
  const ready = await readySandbox(ctx.dataPath);
  const id = ctx.options.positionals[0];
  if (!id && runningSessions(ctx.dataPath).length === 0) await sleep(1500);
  const here = locateHere(ctx, ready);
  if (id) return attachHere(ctx, pickSession(ctx.dataPath, id));
  // Several sessions: choose, this folder's project first (the newest is the default).
  const running = sessionsFirstIn(runningSessions(ctx.dataPath), here.guestDir);
  if (running.length > 1 && process.stdin.isTTY && process.stdout.isTTY) {
    const projects = readRegistry(ctx.storageRoot)?.projects ?? [];
    const chosen = await select({
      message: 'Which session?' + (here.project ? ' (' + here.project.name + ' first)' : ''),
      choices: running.map((s) => ({ value: s.id, name: (here.guestDir && isWithin(here.guestDir, s.cwd) ? '* ' : '  ') + safeText(s.harness).padEnd(9) + ' ' + projectOf(projects, s).padEnd(16) + ' ' + ago(s.startedAt).padEnd(11) + ' ' + s.id })),
    });
    return attachHere(ctx, pickSession(ctx.dataPath, chosen));
  }
  return attachHere(ctx, pickSession(ctx.dataPath, undefined, here.guestDir));
};

type Listed = SessionStatus & { viewers?: Viewers | null; here?: boolean; projectName?: string };

/** Sessions with who is watching them; `here` marks the ones in the project of the current folder. */
const listedSessions = async (ctx: Context): Promise<Listed[]> => {
  // Who is attached comes from each session itself, so a terminal that was closed is never counted.
  const live = isSandboxRunning();
  // Only this sandbox's sessions are asked (and at most MAX_QUERIED_SESSIONS): the sandbox writes these files.
  const ask = new Set(live ? currentSessions(ctx.dataPath).map((s) => s.id) : []);
  const here = live ? locateHere(ctx, readSandboxStatus(ctx.dataPath)) : { guestDir: null };
  const projects = readRegistry(ctx.storageRoot)?.projects ?? [];
  return Promise.all(listSessions(ctx.dataPath).map(async (s) => ({
    ...s, projectName: projectOf(projects, s), here: Boolean(here.guestDir && isWithin(here.guestDir, s.cwd)),
    ...(ask.has(s.id) ? { viewers: await sessionViewers(s) } : {}),
  })));
};

export const sessions = async (ctx: Context): Promise<number> => {
  const list = await listedSessions(ctx);
  if (printJson(ctx, list.map((s) => _.omit(s, 'attach')))) return 0;
  if (list.length === 0) { console.log('No sessions. Start one with: sandbox claude'); return 0; }
  // This folder's project first, newest first within each group; harness, cwd and times are written by the sandbox.
  const ordered = [..._.sortBy(list.filter((s) => s.here), (s) => s.startedAt).reverse(), ..._.sortBy(list.filter((s) => !s.here), (s) => s.startedAt).reverse()];
  const folderWidth = Math.max(16, termWidth() - 80);
  table([['', 'ID', 'AGENT', 'PROJECT', 'STATE', 'ATTACHED', 'FOLDER', 'STARTED'], ...ordered.map((s) => [
    s.here ? '*' : '', s.id, safeText(s.harness), safeText(s.projectName ?? '-'), s.phase + (s.exitCode !== undefined ? ' (' + s.exitCode + ')' : ''), viewerText(s.viewers), shortenMiddle(safeText(s.cwd), folderWidth), ago(s.startedAt),
  ])]);
  if (list.some((s) => s.here)) console.log(c.dim('* = the project of this folder'));
  return 0;
};

/** Running databases by port, from the sandbox's own `sbx-db list` (best effort: unknown when it does not answer). */
const runningPorts = async (ctx: Context, cwd: string): Promise<Set<number> | null> => {
  try {
    const r = await execInSandbox(ctx.dataPath, ['sbx-db', 'list'], cwd, 30, sandboxAlive);
    return new Set((r.stdout ?? '').split(/\r?\n/).filter((l) => /\brunning\b/.test(l)).map((l) => Number(/port (\d+)/.exec(l)?.[1])).filter((n) => n > 0));
  } catch { return null; }
};

export const status = async (ctx: Context): Promise<number> => {
  const running = isSandboxRunning();
  const sandbox = readSandboxStatus(ctx.dataPath);
  const registry = running ? readRegistry(ctx.storageRoot) : null;
  const ready = running && sandbox?.phase === 'ready';
  const daemon = ready ? await pingSandbox(ctx.dataPath, sandboxAlive).then((r) => r.message, (e: unknown) => 'no answer (' + errMsg(e) + ')') : '-';
  const here = running ? locateHere(ctx, sandbox) : { project: null, guestDir: null };
  const sessionList = running ? await listedSessions(ctx) : [];
  const provisioning = running ? listProjectStatus(ctx.dataPath) : [];
  const ports = ready && sandbox ? await runningPorts(ctx, sandbox.guestWorkspace) : null;
  const findings = repoFindings(ctx.dataPath);
  const startedAt = Number(/^(\d+)-/.exec(registry?.launchId ?? sandbox?.launchId ?? '')?.[1]) || null;
  const projects = (registry?.projects ?? []).map((p) => {
    const prov = provisioning.find((s) => s.name.toLowerCase() === p.name.toLowerCase());
    const own = sessionList.filter((s) => s.phase === 'running' && projectForGuestDir(registry?.projects ?? [], s.cwd)?.name === p.name);
    return {
      name: p.name, host: p.host, guest: p.guest, mechanism: p.mechanism, here: here.project?.name === p.name,
      setup: prov ? { phase: prov.phase, message: safeText(prov.message) } : { phase: 'not set up yet', message: 'set up when you first start a session or command there' },
      databases: (prov?.databases ?? []).map((d) => ({ database: safeText(d.database), port: d.port, state: ports ? (ports.has(d.port) ? 'running' : 'stopped') : 'unknown' })),
      sessions: own.map((s) => ({ id: s.id, harness: safeText(s.harness), viewers: viewerText(s.viewers), started: s.startedAt })),
      // With several guarded folders each finding starts with its folder.
      repoGuard: findings.filter((f) => f.detail.toLowerCase().startsWith(p.host.toLowerCase() + ':')).map((f) => f.kind + ': ' + safeText(f.detail)),
    };
  });
  const info = {
    sandbox: {
      running, phase: running ? sandbox?.phase ?? 'unknown' : 'stopped', message: sandbox?.message, headless: sandbox?.headless,
      uptime: running && startedAt ? ago(startedAt).replace(' ago', '') : null, daemon, account: activeAccount(ctx.dataPath), syncWatcher: watcherRunning(ctx.dataPath),
    },
    here: { folder: hereDir(ctx), project: here.project?.name ?? null, guest: here.guestDir },
    roots: registry?.roots ?? [],
    projects,
    otherSessions: sessionList.filter((s) => s.phase === 'running' && !projects.some((p) => p.sessions.some((x) => x.id === s.id))).map((s) => ({ id: s.id, harness: safeText(s.harness), cwd: safeText(s.cwd) })),
    repoGuard: { guarded: guardedProjects(ctx.dataPath).length, findings: findings.map((f) => f.kind + ': ' + f.detail) },
  };
  if (printJson(ctx, info)) return 0;
  const yesNo = (v: unknown): string => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v ?? '-'));
  table(Object.entries(info.sandbox).map(([k, v]) => [_.startCase(k), safeText(yesNo(v))]));
  if (!running) return 0;
  console.log('\n' + c.bold('Projects') + c.dim('  (* = this folder: ' + info.here.folder + (info.here.project ? '' : ', not in this sandbox') + ')'));
  for (const p of projects) {
    console.log((p.here ? '* ' : '  ') + c.bold(p.name) + '  ' + p.host + '  ->  ' + p.guest + c.dim('  (' + (p.mechanism === 'launch' ? 'started from here' : p.mechanism === 'root' ? 'in a project root' : p.mechanism === 'boot' ? 'mapped at start' : 'wsb share') + ')'));
    console.log('      setup: ' + p.setup.phase + (p.setup.phase === 'ready' ? '' : ' - ' + shortenMiddle(p.setup.message, termWidth() - 20)));
    if (p.databases.length) console.log('      databases: ' + p.databases.map((d) => d.database + ' :' + d.port + ' ' + d.state).join(', '));
    for (const s of p.sessions) console.log('      session ' + s.id + '  ' + s.harness + '  ' + s.viewers + '  ' + ago(s.started));
    for (const f of p.repoGuard) console.log('      ' + c.yellow('guard: ' + f));
  }
  for (const r of info.roots) console.log('  root  ' + r.host + '  ->  ' + r.guest + c.dim('  (every project in it opens without a restart)'));
  for (const s of info.otherSessions) console.log('  session ' + s.id + '  ' + s.harness + '  ' + s.cwd);
  console.log('\n' + c.bold('Repo guard') + '  ' + info.repoGuard.guarded + ' folder(s) guarded; ' + (findings.length ? c.yellow(findings.length + ' change(s) neutralised:') : 'nothing from the sandbox needed neutralising'));
  for (const f of info.repoGuard.findings.slice(-10)) console.log('  ' + c.yellow(safeText(f)));
  return 0;
};

/** What a command run in the sandbox printed (text from the sandbox: through safeText), or why it failed. */
const printExecResult = (result: GuestResponse): void => {
  if (result.stdout) process.stdout.write(safeText(result.stdout));
  if (result.stderr) process.stderr.write(safeText(result.stderr));
  if (!result.ok && !result.stdout && !result.stderr) console.error(result.message);
};

/** The guest folder for this folder, joining the running sandbox (and setting the project up) when needed. */
const guestFolderHere = async (ctx: Context, what: string): Promise<string> => {
  const ready = await readySandbox(ctx.dataPath);
  try {
    const joined = await joinHere(ctx, ready);
    for (const note of joined.notes) console.error(note);
    await provisionJoined(ctx, joined);
    return joined.guestDir;
  } catch (e) {
    if (!(e instanceof NeedsRestart)) throw e;
    return fail(hereDir(ctx) + ' is not in the running sandbox (' + e.reason + '), so "sandbox ' + what + '" cannot run there.',
      'sandbox claude (or sandbox start) from that folder offers a restart that adds it; or add its parent folder as a root: sandbox projects roots add "' + path.dirname(e.hostDir) + '"');
  }
};

export const exec = async (ctx: Context): Promise<number> => {
  const command = [...ctx.options.positionals, ...ctx.options.passthrough];
  if (command.length === 0) fail('No command given.', 'Usage: sandbox exec [--timeout <s>] -- <command> [args...]');
  requireOnPc('exec');
  requireRunning();
  const cwd = await guestFolderHere(ctx, 'exec');
  const result = await execInSandbox(ctx.dataPath, command, cwd, ctx.options.timeout, sandboxAlive);
  if (!printJson(ctx, result)) printExecResult(result);
  return result.exitCode ?? 1;
};

/** `sandbox db`: runs the sandbox's own `sbx-db` in this folder's project, which knows its database versions and ports. */
export const db = async (ctx: Context): Promise<number> => {
  const [action = 'list', name] = ctx.options.positionals;
  if (!['list', 'start', 'stop'].includes(action)) fail('Unknown db action "' + action + '".', 'Use: sandbox db  (list)  or  sandbox db start|stop <postgres|mysql|mongodb|redis|dynamodb>');
  if (action !== 'list' && !name) fail('Which database?', 'Usage: sandbox db ' + action + ' <postgres|mysql|mongodb|redis|dynamodb>');
  // Already inside the sandbox: run the database tool here instead of asking the sandbox from outside.
  if (insideSandbox()) return spawnSync(process.execPath, [path.join(ctx.packageRoot, 'dist', 'runtime', 'db.js'), action, ...(name ? [name] : [])], { stdio: 'inherit', windowsHide: true }).status ?? 1;
  requireRunning('Start one with: sandbox start --database <name>');
  const cwd = await guestFolderHere(ctx, 'db');
  // Starting can download the database the first time.
  const result = await working((action === 'list' ? 'Asking' : action === 'start' ? 'Starting' : 'Stopping') + ' the database' + (name ? ' ' + name : 's') + ' in the sandbox', () => execInSandbox(ctx.dataPath, ['sbx-db', action, ...(name ? [name] : [])], cwd, 1800, sandboxAlive));
  printExecResult(result);
  return result.exitCode ?? 1;
};

/** Restarts this folder's project's sessions (--all: every session). */
export const restart = async (ctx: Context): Promise<number> => {
  requireOnPc('restart');
  requireRunning();
  const here = locateHere(ctx, readSandboxStatus(ctx.dataPath));
  const scope = ctx.options.all || !here.project ? undefined : here.project.guest;
  if (!scope && !ctx.options.all) console.log(c.dim(hereDir(ctx) + ' is not a project of the running sandbox: restarting every session.'));
  console.log((await working('Restarting the agents' + (scope ? ' of ' + here.project?.name : ''), () => restartSessions(ctx.dataPath, ctx.options.harness ?? null, sandboxAlive, scope))).message);
  return 0;
};

export const stop = async (ctx: Context): Promise<number> => {
  requireOnPc('stop');
  if (!isSandboxRunning()) { console.log('No Windows Sandbox is running.'); return 0; }
  const sandbox = readSandboxStatus(ctx.dataPath) ?? fail('This sandbox was not started by this tool.', 'Close its window instead.');
  // Stopping ends every project's sessions, not just this folder's: say which, and ask when others would end too.
  const here = locateHere(ctx, sandbox);
  const running = currentSessions(ctx.dataPath);
  const others = running.filter((s) => !(here.guestDir && isWithin(here.project?.guest ?? here.guestDir, s.cwd)));
  if (running.length) console.log('Stopping ends ' + running.length + ' session(s): ' + running.map((s) => safeText(s.harness) + ' in ' + safeText(s.project ?? path.win32.basename(s.cwd))).join(', ') + '.');
  if (others.length && !ctx.options.yes && process.stdin.isTTY && process.stdout.isTTY && !(await askYesNo(others.length + ' of them belong to other projects. Stop the whole sandbox?'))) { console.log('Nothing changed.'); return 1; }
  await working('Asking the sandbox to shut down', () => execInSandbox(ctx.dataPath, ['C:\\Windows\\System32\\shutdown.exe', '/s', '/t', '2'], sandbox.guestWorkspace, 30, sandboxAlive));
  console.log('Sandbox is shutting down; history and claude-mem sync back when it closes.');
  return 0;
};

export const show = (ctx: Context): number => {
  requireOnPc('show');
  requireRunning();
  if (!showSandboxWindow(ctx.storageRoot)) fail('Could not find the Windows Sandbox window.', 'It may still be starting; try again in a few seconds.');
  return 0;
};

export const hide = async (ctx: Context): Promise<number> => {
  requireOnPc('hide');
  requireRunning();
  if (!(await hideSandboxWindow(ctx.storageRoot, 5))) fail('Could not find a visible Windows Sandbox window.', 'It may already be hidden (sbx-show brings it back).');
  console.log('Sandbox window hidden. Bring it back with: sbx-show');
  return 0;
};
