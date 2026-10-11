// `sandbox repair`: finds and fixes common problems. Each check is a small function in CHECKS; it either confirms
// all is well (OK), fixes the problem itself (FIXED), or says what you need to do (NEEDS YOU). Nothing under the data
// folder is followed through a link, and toolchain/run-state fixes wait until no sandbox is running.
import fs from 'node:fs';
import { assertTestWritable } from '../../shared/test-guard.js';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import _ from 'lodash';
import { z } from 'zod';
import { DEFAULTS, loadConfig, userDir } from '../../core/config.js';
import { assertNoLinks, dirExists, errMsg, expandPath, fileExists, isLink, isWin, removeLink, UserError } from '../../core/util.js';
import { resetRunDir } from '../../host/channel.js';
import { isSandboxRunning, sandboxFeatureInstalled } from '../../host/platform.js';
import { listSessions, runPaths, scanRequests } from '../../shared/rundir.js';
import type { CliOptions } from '../args.js';
import { createContext, printJson, table, type Context } from './context.js';
import { humanBytes, removeTree } from './data.js';

export type RepairStatus = 'ok' | 'fixed' | 'needs-you' | 'warn' | 'skipped';
export interface RepairResult { name: string; status: RepairStatus; detail: string }
export interface RepairEnv { ctx: Context; running: boolean; dataPath: string; storageRoot: string; toolsDir: string; configError: UserError | null }
export interface RepairCheck { name: string; run: (env: RepairEnv) => Omit<RepairResult, 'name'> }

const GB = 1024 ** 3;
const LABEL: Record<RepairStatus, string> = { ok: 'OK', fixed: 'FIXED', 'needs-you': 'NEEDS YOU', warn: 'WARNING', skipped: 'SKIPPED' };
const ok = (detail: string): Omit<RepairResult, 'name'> => ({ status: 'ok', detail });
const whileRunning = { status: 'skipped' as const, detail: 'a sandbox is running and may be using it; run repair again once it is closed' };
const rel = (root: string, p: string): string => path.relative(root, p) || '.';

// ---- pure helpers (exported for tests) ----

/** Interrupted downloads and copies: `<name>.staging-<hex>` and `node-staging`, in tools\ and one folder down (tools\go\1.23.staging-ab12). */
export const findStagingLeftovers = (toolsDir: string): string[] => {
  const isStaging = (name: string): boolean => /\.staging-[0-9a-f]+$/i.test(name) || name.toLowerCase() === 'node-staging';
  const realChildren = (dir: string): string[] => (dirExists(dir) && !isLink(dir) ? fs.readdirSync(dir).map((n) => path.join(dir, n)) : []);
  return realChildren(toolsDir).flatMap((p) => (isStaging(path.basename(p)) ? [p] : isLink(p) ? [] : realChildren(p).filter((c) => isStaging(path.basename(c)))));
};

/**
 * A toolchain folder and the program it must contain. `versions` means one folder per installed version (tools\go\1.23.2);
 * `match` limits which version folders count (tools\nvm also holds settings and nvm.exe).
 */
export interface ToolRule { folder: string; exe: string[]; versions?: boolean; match?: RegExp }

export const TOOL_RULES: ToolRule[] = [
  { folder: 'nvm', exe: ['nvm.exe'] },
  { folder: 'nvm', exe: ['node.exe'], versions: true, match: /^v\d+\.\d+\.\d+$/ },
  { folder: 'node', exe: ['node.exe'] },
  { folder: 'git', exe: ['bin', 'bash.exe'] },
  { folder: 'dotnet', exe: ['dotnet.exe'] },
  { folder: 'go', exe: ['bin', 'go.exe'], versions: true },
  { folder: 'java', exe: ['bin', 'java.exe'], versions: true },
  { folder: 'python', exe: ['python.exe'], versions: true },
];

/** Toolchain folders that exist but lack their main program (an install that stopped half way). Never enters links. */
export const findHalfInstalled = (toolsDir: string, rules: ToolRule[] = TOOL_RULES): { path: string; missing: string }[] => {
  const realDir = (p: string): boolean => dirExists(p) && !isLink(p);
  const staging = (name: string): boolean => /\.staging-[0-9a-f]+$/i.test(name) || name.toLowerCase() === 'node-staging';
  return rules.flatMap((rule) => {
    const base = path.join(toolsDir, rule.folder);
    if (!realDir(base)) return [];
    const folders = rule.versions
      ? fs.readdirSync(base).filter((n) => !staging(n) && (!rule.match || rule.match.test(n))).map((n) => path.join(base, n)).filter(realDir)
      : [base];
    return folders.filter((f) => !fileExists(path.join(f, ...rule.exe))).map((f) => ({ path: f, missing: path.join(...rule.exe) }));
  });
};

/**
 * Every link or junction under `root` (the links themselves; nothing behind them is visited). Before descending into
 * a folder its real path must still be inside root: a folder swapped for a junction between two looks is not followed.
 */
export const findLinks = (root: string): string[] => {
  if (isLink(root)) return [root];
  const real = (p: string): string => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return ''; } };
  const top = real(root);
  const inside = (p: string): boolean => { const r = real(p); return r !== '' && (r === top || r.startsWith(top + path.sep)); };
  const walk = (dir: string): string[] => {
    if (!inside(dir)) return [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries.flatMap((d) => {
      const p = path.join(dir, d.name);
      if (d.isSymbolicLink() || isLink(p)) return [p];
      return d.isDirectory() ? walk(p) : [];
    });
  };
  return dirExists(root) ? walk(root) : [];
};

const ResolvedVersions = z.record(z.string(), z.unknown());
/** tools\resolved-versions.json is a JSON object (anything else makes the guest stumble). */
export const resolvedVersionsValid = (text: string): boolean => {
  try { return ResolvedVersions.safeParse(JSON.parse(text.replace(/^﻿/, ''))).success; } catch { return false; }
};

const NpmList = z.object({ dependencies: z.record(z.string(), z.unknown()).optional() });
/** Package names from `npm ls -g --json`; [] when the output is not what npm prints. */
export const globalPackages = (json: string): string[] => {
  try { return Object.keys(NpmList.parse(JSON.parse(json)).dependencies ?? {}); } catch { return []; }
};

const Pid = z.coerce.number().int().positive();
export const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
/** Sync-watcher pid files (storage\run\watcher-*.pid) whose process is gone (or whose content is not a pid). */
export const deadPidFiles = (runDir: string, alive: (pid: number) => boolean = pidAlive): string[] =>
  (dirExists(runDir) ? fs.readdirSync(runDir) : [])
    .filter((n) => /^watcher-.*\.pid$/i.test(n))
    .map((n) => path.join(runDir, n))
    .filter((f) => { try { const pid = Pid.safeParse(fs.readFileSync(f, 'utf8').trim()); return !pid.success || !alive(pid.data); } catch { return false; } });

// ---- checks ----

/** Fails (throws) unless every folder from the data folder to `p` is real. */
const guard = (env: RepairEnv, p: string): void => assertNoLinks(path.dirname(env.dataPath), p);

const CHECKS: RepairCheck[] = [
  {
    name: 'Config file',
    run: (env) => (env.configError
      ? { status: 'needs-you', detail: env.configError.message + (env.configError.fix ? ' ' + env.configError.fix : '') + ' (repair never rewrites your config; built-in defaults were used for the other checks.)' }
      : ok(env.ctx.loaded.configPath ? env.ctx.loaded.configPath + ' is valid.' : 'none; using the built-in defaults.')),
  },
  {
    name: 'Windows Sandbox feature',
    run: () => (sandboxFeatureInstalled() ? ok('enabled.') : { status: 'needs-you', detail: (isWin ? 'Windows Sandbox is not turned on.' : 'This is not Windows.') + ' Run: sandbox setup (it checks this PC and offers to turn it on).' }),
  },
  {
    name: 'Links in the data folder',
    run: (env) => {
      if (isLink(env.dataPath)) return { status: 'needs-you', detail: env.dataPath + ' itself is a link or junction. agent-sandbox refuses to work through links; point storage.root at the real folder instead (sandbox config path).' };
      // A running sandbox can swap folders for links while we look; only check a stopped one.
      if (env.running) return whileRunning;
      const links = findLinks(env.dataPath);
      if (!links.length) return ok('none (nothing in ' + env.dataPath + ' points elsewhere).');
      // A link here can only have been made inside the sandbox; it could point at this PC's own files. Remove the link
      // itself, and only if every folder above it is still real.
      for (const link of links) { guard(env, path.dirname(link)); removeLink(link); }
      return { status: 'fixed', detail: 'removed ' + links.length + ' link(s)/junction(s) the sandbox created, without following them: ' + links.map((l) => rel(env.dataPath, l)).join(', ') };
    },
  },
  {
    name: 'Sandbox run state',
    run: (env) => {
      if (env.running) return ok('a sandbox is running; its state is in use.');
      if (isLink(runPaths(env.dataPath).run)) { resetRunDir(env.dataPath); return { status: 'fixed', detail: 'the run folder was a link; removed the link itself.' }; }
      // The last sandbox's status file is normal after it closes; sessions still marked running or unanswered requests are not.
      const ghosts = listSessions(env.dataPath).filter((s) => s.phase === 'running' || s.phase === 'starting').length;
      const requests = scanRequests(env.dataPath);
      const pending = requests.valid.length + requests.invalid.length;
      if (!ghosts && !pending) return ok('clean.');
      resetRunDir(env.dataPath);
      return { status: 'fixed', detail: 'no sandbox is running, but ' + _.compact([ghosts && ghosts + ' session(s) were still marked running', pending && pending + ' request(s) were never answered']).join(' and ') + '; cleared the run state so status/attach do not show ghosts.' };
    },
  },
  {
    name: 'Hidden-window state',
    run: (env) => {
      const file = path.join(env.storageRoot, 'run', 'hidden-windows.json');
      if (!fs.existsSync(file) && !isLink(file)) return ok('clean.');
      if (env.running) return ok('a sandbox is running; kept.');
      assertTestWritable(file);
      fs.rmSync(file, { force: true });
      return { status: 'fixed', detail: 'removed the saved hidden-window list from a sandbox that is no longer running.' };
    },
  },
  {
    name: 'Sync watcher',
    run: (env) => {
      const dead = deadPidFiles(path.join(env.storageRoot, 'run'));
      if (!dead.length) return ok('no stale watcher records.');
      for (const f of dead) { assertTestWritable(f); fs.rmSync(f, { force: true }); }
      return { status: 'fixed', detail: 'removed ' + dead.length + ' record(s) of a history sync watcher that is no longer running (the next launch starts a new one).' };
    },
  },
  {
    name: 'Interrupted downloads',
    run: (env) => {
      if (env.running) return whileRunning;
      guard(env, env.toolsDir);
      const found = findStagingLeftovers(env.toolsDir);
      if (!found.length) return ok('none.');
      for (const p of found) removeTree(p, env.dataPath);
      return { status: 'fixed', detail: 'removed ' + found.length + ' half-finished download/copy folder(s): ' + found.map((p) => rel(env.toolsDir, p)).join(', ') };
    },
  },
  {
    name: 'Half-installed toolchains',
    run: (env) => {
      if (env.running) return whileRunning;
      guard(env, env.toolsDir);
      const found = findHalfInstalled(env.toolsDir);
      if (!found.length) return ok('every toolchain folder has its program.');
      for (const f of found) removeTree(f.path, env.dataPath);
      return { status: 'fixed', detail: 'removed ' + found.map((f) => rel(env.toolsDir, f.path) + ' (no ' + f.missing + ')').join(', ') + '; the next sandbox reinstalls them.' };
    },
  },
  {
    name: 'Resolved versions cache',
    run: (env) => {
      const file = path.join(env.toolsDir, 'resolved-versions.json');
      if (!fs.existsSync(file) && !isLink(file)) return ok('not created yet.');
      if (env.running) return whileRunning;
      guard(env, env.toolsDir);
      if (isLink(file)) { removeLink(file); return { status: 'fixed', detail: 'removed a link in place of tools\\resolved-versions.json.' }; }
      if (fs.statSync(file).size < 4 * 1024 * 1024 && resolvedVersionsValid(fs.readFileSync(file, 'utf8'))) return ok('valid.');
      assertTestWritable(file);
      fs.rmSync(file, { force: true });
      return { status: 'fixed', detail: 'tools\\resolved-versions.json was damaged; removed it (versions are looked up again on the next start).' };
    },
  },
  {
    name: 'Installed packages',
    run: () => {
      const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!fileExists(npmCli)) return { status: 'skipped', detail: 'npm not found next to this Node (' + npmCli + ').' };
      // cwd = Node's own folder: npm reads .npmrc from the current folder, which could be a sandbox-writable workspace.
      const result = spawnSync(process.execPath, [npmCli, 'ls', '-g', '--json', '--depth=0'], { cwd: path.dirname(process.execPath), encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      const names = globalPackages(result.stdout ?? '');
      if (!names.length) return { status: 'skipped', detail: 'could not read the global npm packages.' };
      if (names.includes('agent-sandbox') && names.includes('windows-development-sandbox')) return { status: 'needs-you', detail: 'the old agent-sandbox package is still installed next to windows-development-sandbox, and their commands clash. Run: npm uninstall -g agent-sandbox' };
      return ok(names.includes('agent-sandbox') ? 'agent-sandbox installed (the old name; fine on its own).' : 'no old agent-sandbox package.');
    },
  },
  {
    name: 'Free disk',
    run: (env) => {
      let at = path.resolve(env.storageRoot);
      while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
      let free: number;
      try { const s = fs.statfsSync(at); free = s.bavail * s.bsize; } catch { return { status: 'skipped', detail: 'could not check the drive of ' + env.storageRoot }; }
      if (free >= 20 * GB) return ok(humanBytes(free) + ' free.');
      return { status: 'warn', detail: humanBytes(free) + ' free on the drive of ' + env.storageRoot + (free < 5 * GB ? ': toolchains need several GB.' : ': getting low.') + ' See what is stored with: sandbox data, and free space with: sandbox data clean <target>' };
    },
  },
];

/** Runs every check in order; a check that throws is reported, never stops the rest. */
export const runChecks = (env: RepairEnv, checks: RepairCheck[] = CHECKS): RepairResult[] => checks.map((check) => {
  try { return { name: check.name, ...check.run(env) }; } catch (e) { return { name: check.name, status: 'needs-you', detail: 'check failed: ' + errMsg(e) + (e instanceof UserError && e.fix ? ' ' + e.fix : '') }; }
});

export const repair = (ctx: Context, configError: UserError | null = null): number => {
  const env: RepairEnv = { ctx, running: isSandboxRunning(), dataPath: ctx.dataPath, storageRoot: ctx.storageRoot, toolsDir: path.join(ctx.dataPath, 'tools'), configError };
  // Re-check the config file even when the context loaded (it may have been edited since, or come from --config).
  if (!env.configError) { try { loadConfig(ctx.options.config); } catch (e) { if (e instanceof UserError) env.configError = e; else throw e; } }
  const results = runChecks(env);
  if (printJson(ctx, results)) return results.some((r) => r.status === 'needs-you') ? 1 : 0;
  table(results.map((r) => [LABEL[r.status], r.name, r.detail]));
  const counts = _.countBy(results, 'status');
  console.log('\n' + (counts['needs-you'] ? counts['needs-you'] + ' thing(s) need you (see NEEDS YOU above).' : 'All good' + (counts.fixed ? ': fixed ' + counts.fixed + ' problem(s).' : '.')));
  return counts['needs-you'] ? 1 : 0;
};

/**
 * Entry point that works even when the config file is broken (createContext would throw): falls back to the built-in
 * defaults so the other checks still run, and reports the config problem as the first check.
 */
export const repairCommand = (packageRoot: string, entry: string, options: CliOptions): number => {
  let ctx: Context;
  try { ctx = createContext(packageRoot, entry, options); } catch (e) {
    if (!(e instanceof UserError)) throw e;
    const loaded = { config: structuredClone(DEFAULTS), configPath: null, base: userDir() };
    const storageRoot = expandPath(loaded.config.storage.root, loaded.base);
    return repair({ packageRoot, entry, options, loaded, storageRoot, dataPath: path.join(storageRoot, 'data', loaded.config.storage.dataName) }, e);
  }
  return repair(ctx);
};
