// `sandbox data`: what persists between sandboxes (toolchains, databases, agent state, logs, host storage) and
// removing chosen parts of it. Everything under the data folder is sandbox-writable: sizes and deletes never follow
// links, and targets resolve strictly inside the data folder.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import _ from 'lodash';
import { removeRefusal, safeRemove } from '../../shared/safe-remove.js';
import { assertNoLinks, dirExists, fail, isInsideOrEqual, isLink, removeLink } from '../../core/util.js';
import { askYesNo } from '../../core/workspace.js';
import { isSandboxRunning } from '../../host/platform.js';
import { printJson, table, type Context } from './context.js';

export type DataArea = 'tools' | 'databases' | 'state' | 'logs' | 'data' | 'host';
export interface DataEntry { area: DataArea; name: string; path: string; bytes: number }

const AREA_ORDER: DataArea[] = ['tools', 'databases', 'state', 'logs', 'data', 'host'];
/** Folders of the data folder that get one row per child; anything else at the top level is listed as itself. */
const PER_CHILD: DataArea[] = ['tools', 'databases', 'state'];

/** 1536 -> "1.5 KB". */
export const humanBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = bytes <= 0 ? 0 : Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return (i === 0 ? String(bytes) : value.toFixed(value < 10 ? 1 : 0)) + ' ' + units[i];
};

/** Size on disk, never following links or junctions (a link counts as 0). */
export const sizeOf = (p: string): number => {
  try {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) return 0;
    if (!stat.isDirectory()) return stat.size;
    return _.sumBy(fs.readdirSync(p, { withFileTypes: true }), (d) => (d.isSymbolicLink() ? 0 : sizeOf(path.join(p, d.name))));
  } catch { return 0; }
};

/**
 * Deletes a folder or file without ever following a link: links found anywhere inside are removed themselves first,
 * then the (now link-free) tree is deleted. A link in place of `p` is removed itself.
 */
/** Deletes p (strictly inside root): links inside are removed first and never followed; see shared/safe-remove.ts. */
export const removeTree = (p: string, root: string): void => {
  const unlinkInside = (dir: string): void => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, d.name);
      if (d.isSymbolicLink() || isLink(child)) removeLink(child); else if (d.isDirectory()) unlinkInside(child);
    }
  };
  if (isLink(p)) { removeLink(p); return; }
  if (!fs.existsSync(p)) return;
  // Refused before anything is touched (safeRemove below checks again).
  const refusal = removeRefusal(p, root);
  if (refusal) throw new Error('Refusing to delete ' + p + ': ' + refusal);
  if (dirExists(p)) unlinkInside(p);
  safeRemove(p, root);
};

/** Real (non-link) children of a real folder; a link in place of the folder yields nothing. */
const entriesOf = (dir: string): fs.Dirent[] => (dirExists(dir) && !isLink(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.isSymbolicLink()) : []);

const toolRows = (toolsDir: string): DataEntry[] => {
  const entries = entriesOf(toolsDir);
  const folders = entries.filter((d) => d.isDirectory());
  const files = entries.filter((d) => !d.isDirectory());
  const row = (name: string, p: string): DataEntry => ({ area: 'tools', name, path: p, bytes: sizeOf(p) });
  return [
    ...folders.flatMap((d) => (d.name.toLowerCase() === 'agents'
      ? entriesOf(path.join(toolsDir, d.name)).map((a) => row('agents/' + a.name, path.join(toolsDir, d.name, a.name)))
      : [row(d.name, path.join(toolsDir, d.name))])),
    ...(files.length ? [{ area: 'tools' as const, name: '(files in tools)', path: toolsDir, bytes: _.sumBy(files, (f) => sizeOf(path.join(toolsDir, f.name))) }] : []),
  ];
};

/** Every row of `sandbox data`: the sandbox's data folder by area, then what this PC keeps for it. */
export const collectDataEntries = (dataPath: string, storageRoot: string): DataEntry[] => {
  const inData = entriesOf(dataPath);
  const rows: DataEntry[] = inData.flatMap((d): DataEntry[] => {
    const p = path.join(dataPath, d.name);
    const area = d.name.toLowerCase() as DataArea;
    if (area === 'tools') return toolRows(p);
    if (PER_CHILD.includes(area)) return entriesOf(p).map((c) => ({ area, name: area + '/' + c.name, path: path.join(p, c.name), bytes: sizeOf(path.join(p, c.name)) }));
    return [{ area: area === 'logs' ? 'logs' : 'data', name: d.name, path: p, bytes: sizeOf(p) }];
  });
  const otherData = entriesOf(path.join(storageRoot, 'data')).filter((d) => d.isDirectory() && path.join(storageRoot, 'data', d.name).toLowerCase() !== path.resolve(dataPath).toLowerCase());
  const host: DataEntry[] = [
    ...['launches', 'accounts', 'sync', 'logs', 'run', 'host'].map((name) => ({ area: 'host' as const, name, path: path.join(storageRoot, name), bytes: sizeOf(path.join(storageRoot, name)) })),
    ...otherData.map((d) => ({ area: 'host' as const, name: 'other data folder: ' + d.name, path: path.join(storageRoot, 'data', d.name), bytes: sizeOf(path.join(storageRoot, 'data', d.name)) })),
  ].filter((r) => fs.existsSync(r.path));
  return _.sortBy([...rows, ...host], (r) => AREA_ORDER.indexOf(r.area), (r) => -r.bytes, (r) => r.name.toLowerCase());
};

const AREA_LABEL: Record<DataArea, string> = { tools: 'Toolchains', databases: 'Databases', state: 'Agent state', logs: 'Logs', data: 'Other', host: 'On this PC' };

export interface DiskUsage { drive: string; totalBytes: number; freeBytes: number; usedBytes: number; holdsStorage: boolean }

/** Every local drive's size and free space, and which one holds the sandbox storage. */
export const diskUsage = (storageRoot: string): DiskUsage[] => {
  const storageDrive = path.parse(path.resolve(storageRoot)).root.toUpperCase();
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => letter + ':\\').flatMap((drive): DiskUsage[] => {
    try {
      const s = fs.statfsSync(drive);
      const totalBytes = s.blocks * s.bsize;
      if (!totalBytes) return [];
      return [{ drive, totalBytes, freeBytes: s.bavail * s.bsize, usedBytes: totalBytes - s.bfree * s.bsize, holdsStorage: drive.toUpperCase() === storageDrive }];
    } catch { return []; }
  });
};

export const dataInfo = (ctx: Context): number => {
  const entries = collectDataEntries(ctx.dataPath, ctx.storageRoot);
  const total = _.sumBy(entries, 'bytes');
  const disks = diskUsage(ctx.storageRoot);
  if (printJson(ctx, { dataPath: ctx.dataPath, storageRoot: ctx.storageRoot, totalBytes: total, entries, disks })) return 0;
  console.log('Disks\n');
  table([['DRIVE', 'USED', 'FREE', 'SIZE', ''], ...disks.map((d) => [d.drive, humanBytes(d.usedBytes) + ' (' + Math.round((d.usedBytes / d.totalBytes) * 100) + '%)', humanBytes(d.freeBytes), humanBytes(d.totalBytes), d.holdsStorage ? '<- sandbox storage (' + humanBytes(total) + ' of it)' : ''])]);
  console.log('');
  console.log('Persistent data for the sandbox: ' + ctx.dataPath + ' (C:\\AgentData inside)\n');
  if (!entries.length) { console.log('Nothing stored yet. Toolchains, databases and agent logins appear here after the first start.'); return 0; }
  const rows = _.flatMap(_.groupBy(entries, 'area'), (group, area) => [
    [AREA_LABEL[area as DataArea], humanBytes(_.sumBy(group, 'bytes')), ''],
    ...group.map((e) => ['  ' + e.name, humanBytes(e.bytes), e.path]),
  ]);
  table([...rows, ['', '', ''], ['Total', humanBytes(total), '']]);
  console.log('\nFree space with: sandbox data clean <target...>  (e.g. tools/go, databases/postgres-18, logs, launches)');
  return 0;
};

// ---- clean ----

export interface CleanTarget {
  /** The target as normalised (forward slashes), e.g. "tools/go". */
  target: string;
  path: string;
  /** Folder the target must stay inside, with no links between the two. */
  root: string;
  warning?: string;
}

const DATA_AREAS = ['tools', 'databases', 'state', 'logs'] as const;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ +@-]*$/;
const LOGIN_WARNING = 'removes the agent logins, settings and history inside the sandbox (save a Claude login first with: sandbox account save <name>)';
const ALL_WARNING = 'removes EVERYTHING the sandbox keeps: toolchains, databases, agent logins and history, logs and launch folders';

/**
 * Turns `sandbox data clean` arguments into folders. Pure (no disk access); throws a UserError for anything that is
 * not a plain relative target inside the data folder: absolute paths, drive letters, `..`, wildcards, unknown areas.
 */
export const resolveCleanTargets = (inputs: string[], dataPath: string, storageRoot: string): CleanTarget[] => {
  const usage = 'Targets: all | tools | tools/<name> | tools/agents/<name> | databases | databases/<name> | state | state/<agent> | logs | launches. See them with: sandbox data';
  if (!inputs.length) fail('Say what to remove.', usage);
  const resolved = inputs.map((raw): CleanTarget => {
    const input = raw.trim();
    if (!input) fail('Empty target.', usage);
    if (path.win32.isAbsolute(input) || path.posix.isAbsolute(input) || /^[A-Za-z]:/.test(input) || input.includes(':')) fail('Refusing "' + raw + '": targets are relative to the data folder, not paths on this PC.', usage);
    const parts = input.replace(/\\/g, '/').split('/').filter(Boolean);
    const bad = parts.find((p) => !SEGMENT.test(p) || /^\.+$/.test(p) || /[. ]$/.test(p));
    if (bad !== undefined) fail('Refusing "' + raw + '": "' + bad + '" is not a plain folder name (no .., wildcards or special characters).', usage);
    const [head, ...rest] = parts;
    const area = head.toLowerCase();
    if (parts.length > 3) fail('Refusing "' + raw + '": too deep.', usage);
    const target = [area, ...rest].join('/');
    if (area === 'all' && !rest.length) return { target: 'all', path: dataPath, root: path.join(storageRoot, 'data'), warning: ALL_WARNING };
    if (area === 'launches') return { target, path: path.join(storageRoot, 'launches', ...rest), root: storageRoot };
    if (area === 'accounts' || area === 'sync') fail('"' + area + '" is kept on this PC on purpose and is not removed here.', area === 'accounts' ? 'Remove a saved login with: sandbox account remove <name>' : usage);
    if (!(DATA_AREAS as readonly string[]).includes(area)) fail('Unknown target "' + raw + '".', usage);
    if (area === 'logs' && rest.length) fail('Remove all logs ("logs"), not single files.', usage);
    if (rest.length > (area === 'tools' && rest[0]?.toLowerCase() === 'agents' ? 2 : 1)) fail('Refusing "' + raw + '": too deep.', usage);
    return { target, path: path.join(dataPath, area, ...rest), root: dataPath, ...(area === 'state' ? { warning: LOGIN_WARNING } : {}) };
  });
  // "all" covers everything; otherwise drop targets inside another target (tools + tools/go = tools).
  const all = resolved.find((t) => t.target === 'all');
  if (all) return [all, { target: 'launches', path: path.join(storageRoot, 'launches'), root: storageRoot }];
  const unique = _.uniqBy(resolved, (t) => t.path.toLowerCase());
  return unique.filter((t) => !unique.some((o) => o !== t && isInsideOrEqual(o.path, t.path)));
};

/** Asks the user to type `expected` (a stronger confirmation than y/N). */
const askTyped = async (question: string, expected: string): Promise<boolean> => {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question + ' Type "' + expected + '" to confirm: ', resolve));
  rl.close();
  return answer.trim().toLowerCase() === expected;
};

export const dataClean = async (ctx: Context): Promise<number> => {
  const targets = resolveCleanTargets(ctx.options.positionals.slice(1), ctx.dataPath, ctx.storageRoot);
  if (isSandboxRunning()) fail('A Windows Sandbox is running, and it uses these folders.', 'Close it first (sandbox stop), then run this again.');
  // Every folder from the root down to the target's parent must be real; a link in place of the target is removed itself.
  for (const t of targets) assertNoLinks(t.root, path.dirname(t.path));
  const present = targets.filter((t) => fs.existsSync(t.path) || isLink(t.path));
  if (!present.length) { console.log('Nothing to remove: ' + targets.map((t) => t.target).join(', ') + ' do(es) not exist.'); return 0; }
  const sized = present.map((t) => ({ ...t, bytes: sizeOf(t.path) }));
  const total = _.sumBy(sized, 'bytes');
  table(sized.map((t) => ['  ' + t.target, humanBytes(t.bytes), t.path]));
  for (const t of sized) if (t.warning) console.log('Warning: ' + t.target + ' ' + t.warning + '.');
  const yes = Boolean((ctx.options as { yes?: boolean }).yes);
  if (!yes) {
    const ok = sized.some((t) => t.target === 'all')
      ? await askTyped('This cannot be undone; the next sandbox starts from scratch and reinstalls everything.', 'all')
      : await askYesNo('Remove ' + (sized.length === 1 ? 'this' : 'these ' + sized.length) + ' (' + humanBytes(total) + ')?');
    if (!ok) { console.log('Nothing removed.' + (process.stdin.isTTY ? '' : ' Pass --yes to confirm without a prompt.')); return 1; }
  }
  const failed: string[] = [];
  for (const t of sized) {
    try { removeTree(t.path, t.root); } catch (e) { failed.push(t.target + ' (' + (e instanceof Error ? e.message : String(e)) + ')'); }
  }
  const freed = total - _.sumBy(sized, (t) => sizeOf(t.path));
  console.log('Freed ' + humanBytes(freed) + '. ' + (sized.some((t) => t.root === ctx.dataPath || t.target === 'all') ? 'The next sandbox reinstalls what it needs.' : ''));
  if (failed.length) fail('Could not remove everything: ' + failed.join('; '), 'Close programs using those folders and run the same command again.');
  return 0;
};

/** `sandbox data [info|clean] [targets...]`. */
export const data = (ctx: Context): number | Promise<number> => {
  const [action = 'info'] = ctx.options.positionals;
  switch (action) {
    case 'info': case 'show': case 'list': return dataInfo(ctx);
    case 'clean': case 'remove': return dataClean(ctx);
    default: return fail('Unknown data action "' + action + '".', 'Use: sandbox data  (what is stored)  or  sandbox data clean <target...>');
  }
};
