// Two-way sync of Claude Code history between this PC and the sandbox's persistent state.
//
// Claude keeps transcripts per working folder (~/.claude/projects/<folder with every non-alphanumeric char as '-'>)
// and writes absolute paths inside them. The sandbox sees the workspace under a different path, so the current
// project's folder is renamed and paths inside its files are translated in both directions. Everything else is
// copied as-is, newest file wins, and modification times are preserved so repeated syncs are cheap.
//
// Safety (the sandbox side is untrusted):
//  - links are never followed or written through, on either side;
//  - what comes BACK is limited to transcripts (.jsonl), prompt history and to-do lists (.json), each capped in
//    size, and never Claude's memory folders. Nothing executable or instruction-like flows to this PC.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { guestWorkspaceAliases, projectFolderName, translatePaths } from '../shared/paths.js';
import { dirExists, ensureDir, fileExists, isLink, removeLink, tryReadJson, writeJson } from '../core/util.js';

export { projectFolderName, translatePaths };

const SESSION_DIRS = ['todos', 'plans', 'file-history'];
const DATA_FILE = /\.(jsonl?|txt|md)$/i;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Host-only record of the last launch: which folders map to each other and what syncs (from the effective config). */
export interface SyncState {
  hostClaudeDir: string; hostWorkspace: string; guestWorkspace: string;
  syncHistory?: boolean; syncClaudeMem?: boolean;
  /** Newest claude-mem database time on each side right after the last sync (detects edits on both sides). */
  memHostStamp?: number; memGuestStamp?: number;
}
export interface SyncPaths { hostClaudeDir: string; guestClaudeDir: string; hostWorkspace: string; guestWorkspace: string }
type Filter = (name: string) => boolean;
interface CopyOptions { transform?: (text: string) => string; accept?: Filter; skipDirs?: RegExp }

const anyFile: Filter = () => true;
const transcript: Filter = (name) => name.endsWith('.jsonl');
const json: Filter = (name) => name.endsWith('.json');
/** Claude's auto-memory is loaded into every host session, so the sandbox must never write it. */
const NO_MEMORY = /^memory$/i;

const newerThan = (source: fs.Stats, destination: string): boolean => {
  try { return source.mtimeMs > fs.statSync(destination).mtimeMs + 1; } catch { return true; }
};

/** Writes a file, replacing a link at that path instead of writing through it. */
const writeSafely = (destination: string, write: () => void): void => {
  if (isLink(destination)) removeLink(destination);
  write();
};

/** Copies files that are newer in `from`, optionally translating text content, and keeps the source mtime. */
const copyNewer = (from: string, to: string, options: CopyOptions = {}): number => {
  if (!dirExists(from) || isLink(from) || isLink(to)) return 0;
  const accept = options.accept ?? anyFile;
  return _.sumBy(fs.readdirSync(from, { withFileTypes: true }), (entry: fs.Dirent): number => {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) return options.skipDirs?.test(entry.name) ? 0 : copyNewer(source, destination, options);
    if (!entry.isFile() || !accept(entry.name)) return 0;
    const stat = fs.statSync(source);
    if (stat.size > MAX_FILE_BYTES || !newerThan(stat, destination)) return 0;
    ensureDir(to);
    writeSafely(destination, () => {
      if (!options.transform || !DATA_FILE.test(entry.name)) { fs.copyFileSync(source, destination); return; }
      let text = fs.readFileSync(source, 'utf8');
      // A transcript can be mid-write; only take complete lines, the rest arrives with the next sync.
      if (entry.name.endsWith('.jsonl') && !text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1);
      fs.writeFileSync(destination, options.transform(text), 'utf8');
    });
    fs.utimesSync(destination, stat.atime, stat.mtime);
    return 1;
  });
};

const readLines = (file: string): string[] =>
  fileExists(file) && !isLink(file) && fs.statSync(file).size <= MAX_FILE_BYTES ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '') : [];
const lineTime = (line: string): number => { try { return Number((JSON.parse(line) as { timestamp?: number }).timestamp) || 0; } catch { return 0; } };

/** Brings this PC's history into the sandbox state (run before the sandbox starts). Returns files copied. */
export const syncHistoryIn = (p: SyncPaths): number => {
  const hostProject = projectFolderName(p.hostWorkspace);
  const guestProject = projectFolderName(p.guestWorkspace);
  const transform = (t: string): string => translatePaths(t, p.hostWorkspace, p.guestWorkspace);
  const hostProjects = path.join(p.hostClaudeDir, 'projects');
  const names = dirExists(hostProjects) ? fs.readdirSync(hostProjects).filter((name) => name !== guestProject || hostProject === guestProject) : [];
  const projects = _.sumBy(names, (name) => name === hostProject
    ? copyNewer(path.join(hostProjects, name), path.join(p.guestClaudeDir, 'projects', guestProject), { transform })
    : copyNewer(path.join(hostProjects, name), path.join(p.guestClaudeDir, 'projects', name)));
  const sessions = _.sumBy(SESSION_DIRS, (dir) => copyNewer(path.join(p.hostClaudeDir, dir), path.join(p.guestClaudeDir, dir)));

  // Prompt history: rebuild the sandbox copy from this PC's file plus anything only the sandbox has.
  const target = path.join(p.guestClaudeDir, 'history.jsonl');
  const hostLines = readLines(path.join(p.hostClaudeDir, 'history.jsonl')).map(transform);
  const known = new Set(hostLines);
  const merged = _.sortBy([...hostLines, ...readLines(target).filter((l) => !known.has(l))], lineTime);
  if (merged.length) { ensureDir(p.guestClaudeDir); writeSafely(target, () => fs.writeFileSync(target, merged.join('\n') + '\n', 'utf8')); }
  return projects + sessions;
};

/** Copies new sandbox history back to this PC (safe while the sandbox runs: transcripts are append-only). */
export const syncHistoryOut = (p: SyncPaths): number => {
  const hostProject = projectFolderName(p.hostWorkspace);
  // A mirrored workspace on F: really lives at C:\Mirror\F\...; tools that resolve real paths record that one.
  const guestNames = guestWorkspaceAliases(p.guestWorkspace);
  const guestProjects = new Set(guestNames.map(projectFolderName));
  const transform = (t: string): string => guestNames.reduce((out, guest) => translatePaths(out, guest, p.hostWorkspace), t);
  const guestProjectsDir = path.join(p.guestClaudeDir, 'projects');
  const names = dirExists(guestProjectsDir) && !isLink(guestProjectsDir) ? fs.readdirSync(guestProjectsDir) : [];
  const projects = _.sumBy(names, (name) => guestProjects.has(name)
    ? copyNewer(path.join(guestProjectsDir, name), path.join(p.hostClaudeDir, 'projects', hostProject), { accept: transcript, skipDirs: NO_MEMORY, transform })
    : copyNewer(path.join(guestProjectsDir, name), path.join(p.hostClaudeDir, 'projects', name), { accept: transcript, skipDirs: NO_MEMORY }));
  // Only to-do lists come back besides transcripts; plans and file backups stay in the sandbox.
  const sessions = copyNewer(path.join(p.guestClaudeDir, 'todos'), path.join(p.hostClaudeDir, 'todos'), { accept: json });

  const hostFile = path.join(p.hostClaudeDir, 'history.jsonl');
  const known = new Set(readLines(hostFile));
  const missing = readLines(path.join(p.guestClaudeDir, 'history.jsonl')).map(transform).filter((l) => !known.has(l));
  if (missing.length) { ensureDir(p.hostClaudeDir); fs.appendFileSync(hostFile, missing.join('\n') + '\n', 'utf8'); }
  return projects + sessions + missing.length;
};

/**
 * Host-only: <storage>\sync\<dataName>.json. It records which folder on this PC history flows back into, so it must
 * never live in the data folder the sandbox can write (a forged copy could redirect writes anywhere on this PC).
 */
export const syncStatePath = (dataPath: string): string => path.join(path.dirname(path.dirname(dataPath)), 'sync', path.basename(dataPath) + '.json');
export const readSyncState = (dataPath: string): SyncState | null => tryReadJson<SyncState>(syncStatePath(dataPath));
export const writeSyncState = (dataPath: string, state: SyncState): void => writeJson(syncStatePath(dataPath), state);
