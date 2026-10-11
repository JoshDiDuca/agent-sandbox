// Two-way sync of Claude Code history and claude-mem data between this PC and the sandbox's persistent state.
//
// Claude keeps transcripts per working folder (~/.claude/projects/<folder with every non-alphanumeric char as '-'>)
// and writes absolute paths inside them. The sandbox sees the workspace under a different path, so the current
// project's folder is renamed and paths inside its files are translated in both directions. Everything else is
// copied as-is, newest file wins, and modification times are preserved so repeated syncs are cheap.
//
// Safety: data coming BACK from the sandbox is limited to plain data files (.jsonl/.json/.txt/.md), no symlinks,
// capped in size. Nothing executable (settings, hooks, plugins) ever flows from the sandbox to this PC.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { projectFolderName, translatePaths } from '../shared/paths.js';
import { dirExists, ensureDir, fileExists, homeDir, tryReadJson, writeJson } from '../core/util.js';

export { projectFolderName, translatePaths };

const SESSION_DIRS = ['todos', 'plans', 'file-history'];
const DATA_FILE = /\.(jsonl?|txt|md)$/i;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MEM_SKIP = /(^logs$|\.pid$|\.port$|\.lock$|^worker.*\.json$|\.incoming$)/i;

export interface SyncState {
  hostClaudeDir: string; hostWorkspace: string; guestWorkspace: string;
  /** Newest claude-mem file time on each side right after the last sync (detects edits on both sides). */
  memHostStamp?: number; memGuestStamp?: number;
}
export interface SyncPaths { hostClaudeDir: string; guestClaudeDir: string; hostWorkspace: string; guestWorkspace: string }
interface CopyOptions { transform?: (text: string) => string; dataOnly?: boolean }

const newerThan = (source: fs.Stats, destination: string): boolean => {
  try { return source.mtimeMs > fs.statSync(destination).mtimeMs + 1; } catch { return true; }
};

/** Copies files that are newer in `from`, optionally translating text content, and keeps the source mtime. */
const copyNewer = (from: string, to: string, options: CopyOptions = {}): number => {
  if (!dirExists(from)) return 0;
  return _.sumBy(fs.readdirSync(from, { withFileTypes: true }), (entry: fs.Dirent): number => {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) return copyNewer(source, destination, options);
    if (!entry.isFile() || (options.dataOnly && !DATA_FILE.test(entry.name))) return 0;
    const stat = fs.statSync(source);
    if (stat.size > MAX_FILE_BYTES || !newerThan(stat, destination)) return 0;
    ensureDir(to);
    if (options.transform && DATA_FILE.test(entry.name)) {
      let text = fs.readFileSync(source, 'utf8');
      // A transcript can be mid-write; only take complete lines, the rest arrives with the next sync.
      if (entry.name.endsWith('.jsonl') && !text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1);
      fs.writeFileSync(destination, options.transform(text), 'utf8');
    } else {
      fs.copyFileSync(source, destination);
    }
    fs.utimesSync(destination, stat.atime, stat.mtime);
    return 1;
  });
};

const readLines = (file: string): string[] => (fileExists(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l: string) => l.trim() !== '') : []);
const lineTime = (line: string): number => { try { return Number((JSON.parse(line) as { timestamp?: number }).timestamp) || 0; } catch { return 0; } };

/** Brings this PC's history into the sandbox state (run before the sandbox starts). Returns files copied. */
export const syncHistoryIn = (p: SyncPaths): number => {
  const hostProject = projectFolderName(p.hostWorkspace);
  const guestProject = projectFolderName(p.guestWorkspace);
  const transform = (t: string): string => translatePaths(t, p.hostWorkspace, p.guestWorkspace);
  const hostProjects = path.join(p.hostClaudeDir, 'projects');
  const projects = dirExists(hostProjects)
    ? _.sumBy(fs.readdirSync(hostProjects).filter((name) => name !== guestProject || hostProject === guestProject), (name: string) =>
      name === hostProject
        ? copyNewer(path.join(hostProjects, name), path.join(p.guestClaudeDir, 'projects', guestProject), { transform })
        : copyNewer(path.join(hostProjects, name), path.join(p.guestClaudeDir, 'projects', name)))
    : 0;
  const sessions = _.sumBy(SESSION_DIRS, (dir) => copyNewer(path.join(p.hostClaudeDir, dir), path.join(p.guestClaudeDir, dir)));

  // Prompt history: rebuild the sandbox copy from this PC's file plus anything only the sandbox has.
  const hostLines = readLines(path.join(p.hostClaudeDir, 'history.jsonl')).map(transform);
  const known = new Set(hostLines);
  const merged = _.sortBy([...hostLines, ...readLines(path.join(p.guestClaudeDir, 'history.jsonl')).filter((l) => !known.has(l))], lineTime);
  if (merged.length) { ensureDir(p.guestClaudeDir); fs.writeFileSync(path.join(p.guestClaudeDir, 'history.jsonl'), merged.join('\n') + '\n', 'utf8'); }
  return projects + sessions;
};

/** Copies new sandbox history back to this PC (safe while the sandbox runs: transcripts are append-only). */
export const syncHistoryOut = (p: SyncPaths): number => {
  const hostProject = projectFolderName(p.hostWorkspace);
  const guestProject = projectFolderName(p.guestWorkspace);
  const transform = (t: string): string => translatePaths(t, p.guestWorkspace, p.hostWorkspace);
  const guestProjects = path.join(p.guestClaudeDir, 'projects');
  const projects = dirExists(guestProjects)
    ? _.sumBy(fs.readdirSync(guestProjects), (name: string) =>
      copyNewer(path.join(guestProjects, name), path.join(p.hostClaudeDir, 'projects', name === guestProject ? hostProject : name), { dataOnly: true, transform: name === guestProject ? transform : undefined }))
    : 0;
  const sessions = _.sumBy(SESSION_DIRS, (dir) => copyNewer(path.join(p.guestClaudeDir, dir), path.join(p.hostClaudeDir, dir), { dataOnly: dir !== 'file-history' }));

  const hostFile = path.join(p.hostClaudeDir, 'history.jsonl');
  const known = new Set(readLines(hostFile));
  const missing = readLines(path.join(p.guestClaudeDir, 'history.jsonl')).map(transform).filter((l) => !known.has(l));
  if (missing.length) { ensureDir(p.hostClaudeDir); fs.appendFileSync(hostFile, missing.join('\n') + '\n', 'utf8'); }
  return projects + sessions + missing.length;
};

// ---- claude-mem -------------------------------------------------------------------------------------------------

export const hostClaudeMemDir = (): string => process.env.CLAUDE_MEM_DATA_DIR ?? path.join(homeDir(), '.claude-mem');

const newestMtime = (dir: string): number => {
  if (!dirExists(dir)) return 0;
  return _.max(fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !MEM_SKIP.test(e.name)).map((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs;
  })) ?? 0;
};

/** Replaces `to` with a copy of `from` via a staging folder, so a failure never leaves half a database. */
const mirror = (from: string, to: string): void => {
  const incoming = to + '.incoming';
  fs.rmSync(incoming, { recursive: true, force: true });
  fs.cpSync(from, incoming, { recursive: true, filter: (src: string) => src === from || !MEM_SKIP.test(path.basename(src)) });
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(incoming, to);
};

export type MemResult = 'none' | 'copied-in' | 'copied-out' | 'unchanged' | 'conflict';

/**
 * Whole-folder sync of claude-mem data (its SQLite database and vector store cannot be merged file by file).
 * Direction is decided by which side changed since the last sync; if BOTH changed, the side about to be overwritten
 * is first parked next to it as `<dir>.conflict-<time>` so nothing is ever lost.
 */
export const syncClaudeMem = (hostDir: string, guestDir: string, state: SyncState, direction: 'in' | 'out'): MemResult => {
  const hostStamp = newestMtime(hostDir);
  const guestStamp = newestMtime(guestDir);
  if (hostStamp === 0 && guestStamp === 0) return 'none';
  const hostChanged = hostStamp > (state.memHostStamp ?? 0) + 1;
  const guestChanged = state.memGuestStamp !== undefined && guestStamp > state.memGuestStamp + 1;
  const [source, target] = direction === 'in' ? [hostDir, guestDir] : [guestDir, hostDir];
  let result: MemResult = 'unchanged';
  if (hostChanged && guestChanged) {
    fs.cpSync(target, target + '.conflict-' + Date.now(), { recursive: true });
    mirror(source, target);
    result = 'conflict';
  } else if (direction === 'in' && hostStamp > 0 && (hostChanged || guestStamp === 0)) { mirror(source, target); result = 'copied-in'; }
  else if (direction === 'out' && guestChanged) { mirror(source, target); result = 'copied-out'; }
  state.memHostStamp = newestMtime(hostDir);
  state.memGuestStamp = newestMtime(guestDir);
  return result;
};

export const syncStatePath = (dataPath: string): string => path.join(dataPath, 'run', 'sync.json');
export const readSyncState = (dataPath: string): SyncState | null => tryReadJson<SyncState>(syncStatePath(dataPath));
export const writeSyncState = (dataPath: string, state: SyncState): void => writeJson(syncStatePath(dataPath), state);
