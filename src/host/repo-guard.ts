// Zero-click protection for the folder the sandbox shares with this PC.
//
// The agent can write the workspace. Two kinds of change there would run code on THIS PC without you doing anything
// unusual, so they are snapshotted before launch, re-checked every minute while the sandbox runs and when it closes,
// and neutralised:
//  - git: new or changed hooks, and config that makes git run programs (core.fsmonitor, core.sshCommand, filters,
//    include.path, ...), plus files that redirect where git reads config and hooks (commondir, config.worktree);
//  - commands: executables dropped in the project root under the name of something you type there (node.exe,
//    git.cmd, npm.cmd, ...), because Windows runs a program from the current folder before searching PATH.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { z } from 'zod';
import { readValid, writeFileAtomic, writeJsonAtomic } from '../shared/rundir.js';
import { assertTestWritable } from './test-guard.js';
import { dirExists, fileExists, isLink } from '../core/util.js';

/** Config keys that make git run a program, or load more config. */
const DANGEROUS_KEY = /^(fsmonitor|hookspath|sshcommand|pager|editor|askpass|program|gpgprogram|textconv|command|cmd|clean|smudge|process|driver|helper|uploadpack|receivepack|path|attributesfile|excludesfile|worktree|worktreeconfig|gitproxy|proxycommand|sendemailvalidate|tool)\s*=/i;
const SECTION = /^\s*\[([^\]]*)\]\s*/;
const MARK = '# [agent-sandbox] disabled, added inside the sandbox: ';
/** Files in .git that make git read config/hooks from somewhere else. */
const REDIRECTS = ['commondir', 'config.worktree'];
/** Names you are likely to run in a project folder; with any of these extensions Windows would pick the local copy. */
const COMMANDS = new RegExp('^(' + [
  // this tool's own commands (package.json "bin")
  'sandbox', 'windows-development-sandbox', 'agent-sandbox', 'claude-sbx', 'claude-sandbox', 'codex-sbx', 'codex-sandbox', 'gemini-sbx', 'gemini-sandbox', 'claude-host', 'sbx-show', 'sbx-hide',
  // agents
  'claude', 'codex', 'gemini', 'opencode', 'qwen', 'crush', 'copilot', 'kilo', 'kilocode', 'amp', 'cline', 'cn', 'kimi', 'reasonix', 'codewhale', 'aider', 'cursor-agent', 'agent', 'goose',
  // toolchains and everyday tools
  'node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'corepack', 'volta', 'nvm', 'deno', 'bun', 'bunx', 'tsc', 'git', 'gh', 'code', 'python', 'python3', 'py', 'pip', 'pip3', 'uv', 'uvx', 'pyenv', 'poetry',
  'cargo', 'rustc', 'rustup', 'dotnet', 'nuget', 'msbuild', 'go', 'java', 'javac', 'mvn', 'mvnw', 'gradle', 'gradlew', 'ruby', 'gem', 'bundle', 'rake', 'rails', 'php', 'composer',
  'make', 'cmake', 'ninja', 'gcc', 'g\\+\\+', 'clang', 'psql', 'mysql', 'mariadb', 'mongosh', 'redis-cli', 'docker', 'kubectl', 'terraform', 'az', 'aws',
  'powershell', 'pwsh', 'cmd', 'where', 'tasklist', 'tar', 'curl', 'ssh', 'scp',
].join('|') + ')\\.(exe|com|bat|cmd|vbs|vbe|js|jse|wsf|wsh|msc|ps1)$', 'i');

export interface RepoSnapshot { gitDir: boolean; config: string[]; hooks: Record<string, string>; redirects: string[]; commands: Record<string, string> }
export interface RepoFinding { kind: 'hook' | 'config' | 'git' | 'command'; detail: string }

/** SHA-256 in small chunks: a sandbox can plant a multi-gigabyte "node.exe" to exhaust this PC's memory. */
const hash = (file: string): string => {
  if (isLink(file)) return 'link';
  const sum = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1 << 20);
  let fd: number;
  // A file that cannot be read (locked by a program in the sandbox) never matches the snapshot, so it is dealt with.
  try { fd = fs.openSync(file, 'r'); } catch { return 'unreadable-' + crypto.randomBytes(4).toString('hex'); }
  try { for (let n = fs.readSync(fd, buffer, 0, buffer.length, null); n > 0; n = fs.readSync(fd, buffer, 0, buffer.length, null)) sum.update(buffer.subarray(0, n)); } finally { fs.closeSync(fd); }
  return sum.digest('hex');
};
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const plainGitDir = (workspace: string): string | null => {
  const dir = path.join(workspace, '.git');
  return dirExists(dir) && !isLink(dir) ? dir : null;
};

const filesIn = (dir: string, accept: (name: string) => boolean): Record<string, string> =>
  dirExists(dir) && !isLink(dir)
    ? Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).filter((e) => (e.isFile() || e.isSymbolicLink()) && accept(e.name)).map((e) => [e.name, hash(path.join(dir, e.name))]))
    : {};

const configLines = (dir: string): string[] => {
  const file = path.join(dir, 'config');
  return fileExists(file) && !isLink(file) && fs.statSync(file).size <= MAX_CONFIG_BYTES ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
};

export const snapshotRepo = (workspace: string): RepoSnapshot => {
  const dir = plainGitDir(workspace);
  return {
    gitDir: dir !== null,
    config: dir ? configLines(dir) : [],
    hooks: dir ? filesIn(path.join(dir, 'hooks'), (n) => !n.endsWith('.sample')) : {},
    redirects: dir ? REDIRECTS.filter((n) => fs.existsSync(path.join(dir, n))) : [],
    commands: filesIn(workspace, (n) => COMMANDS.test(n)),
  };
};

/** Moves files into <dir>\agent-sandbox-quarantine\<time>\ and reports them. */
const quarantine = (from: string, names: string[], into: string, kind: RepoFinding['kind']): RepoFinding[] => {
  if (names.length === 0) return [];
  const target = path.join(into, 'agent-sandbox-quarantine', String(Date.now()));
  fs.mkdirSync(target, { recursive: true });
  return names.map((name) => {
    try { fs.renameSync(path.join(from, name), path.join(target, name)); } catch (e) {
      return { kind, detail: name + ' (could not be moved: ' + (e as NodeJS.ErrnoException).code + '; delete it yourself before running anything here)' };
    }
    return { kind, detail: name + ' (moved to ' + target + ')' };
  });
};

/** Comments out newly added config lines that make git run programs. Existing lines are never touched. */
const disableConfig = (dir: string, before: string[]): RepoFinding[] => {
  const lines = configLines(dir);
  const known = _.countBy(before);
  const seen: Record<string, number> = {};
  const findings: RepoFinding[] = [];
  let inInclude = false;
  const fixed = lines.map((line) => {
    const header = SECTION.exec(line);
    if (header) inInclude = /^include(if\s+"[^"]*")?$/i.test(header[1].trim());
    seen[line] = (seen[line] ?? 0) + 1;
    if (line.startsWith(MARK) || seen[line] <= (known[line] ?? 0)) return line;
    // git also accepts "[core] fsmonitor = x" on one line, so look past a leading section header.
    const keyPart = line.replace(SECTION, '').trim();
    if (!(DANGEROUS_KEY.test(keyPart) || (inInclude && keyPart.includes('=')))) return line;
    findings.push({ kind: 'config', detail: line.trim() });
    return MARK + line.trim();
  });
  if (findings.length) writeFileAtomic(path.join(dir, 'config'), fixed.join('\n'));
  const file = path.join(dir, 'config');
  // A link or a huge file is not read at all, so say so instead of letting it pass as "nothing found".
  const unchecked = isLink(file) ? '.git/config is a link' : lines.length === 0 && fileExists(file) && fs.statSync(file).size > MAX_CONFIG_BYTES ? '.git/config is over 4 MB' : null;
  if (unchecked) findings.push({ kind: 'git', detail: unchecked + ', so it cannot be checked. Do not run git in this folder until you have looked at it.' });
  return findings;
};

/**
 * Compares the workspace with its pre-launch snapshot and neutralises anything new that would execute on this PC.
 * Returns what was found (and fixed). Never touches what was already there before the sandbox ran.
 */
export const guardRepo = (workspace: string, before: RepoSnapshot): RepoFinding[] => {
  assertTestWritable(workspace);
  const findings: RepoFinding[] = [];
  const commandsNow = filesIn(workspace, (n) => COMMANDS.test(n));
  findings.push(...quarantine(workspace, Object.keys(commandsNow).filter((n) => before.commands[n] !== commandsNow[n]), workspace, 'command'));

  const dir = plainGitDir(workspace);
  if (!dir) {
    const replaced = before.gitDir && fs.existsSync(path.join(workspace, '.git'));
    if (replaced) findings.push({ kind: 'git', detail: '.git was replaced by a link or a "gitdir:" file inside the sandbox. Do not run git in ' + workspace + ' until you have checked it.' });
    return findings;
  }
  const hooksDir = path.join(dir, 'hooks');
  const hooksNow = filesIn(hooksDir, (n) => !n.endsWith('.sample'));
  findings.push(...quarantine(hooksDir, Object.keys(hooksNow).filter((n) => before.hooks[n] !== hooksNow[n]), dir, 'hook'));
  findings.push(...quarantine(dir, REDIRECTS.filter((n) => fs.existsSync(path.join(dir, n)) && !before.redirects.includes(n)), dir, 'git'));
  findings.push(...disableConfig(dir, before.config));
  return findings;
};

// ---- snapshot storage (host-only, next to the sync state) ---------------------------------------------------------

const syncDir = (dataPath: string): string => path.join(path.dirname(path.dirname(dataPath)), 'sync');
const snapshotFile = (dataPath: string): string => path.join(syncDir(dataPath), path.basename(dataPath) + '-repo.json');
const findingsFile = (dataPath: string): string => path.join(syncDir(dataPath), path.basename(dataPath) + '-repo-findings.json');

const Finding = z.object({ kind: z.enum(['hook', 'config', 'git', 'command']), detail: z.string().max(4096), at: z.string().max(64).optional() });
const Saved = z.object({
  workspace: z.string().max(1024).refine((p) => path.isAbsolute(p)),
  snapshot: z.object({ gitDir: z.boolean(), config: z.array(z.string()), hooks: z.record(z.string(), z.string()), redirects: z.array(z.string()), commands: z.record(z.string(), z.string()) }),
});

/**
 * Every project the sandbox can write, and the project roots (whole folders of projects) it has mapped. Older
 * versions saved a single object.
 */
type SavedT = z.output<typeof Saved>;
const Store = z.strictObject({ projects: z.array(Saved).max(4096), roots: z.array(z.string().max(1024).refine((p) => path.isAbsolute(p))).max(64) });
const StoreAny = z.union([Store, Saved.transform((s) => ({ projects: [s], roots: [] as string[] }))]);
const readStore = (dataPath: string): z.output<typeof Store> => readValid(StoreAny, snapshotFile(dataPath)) ?? { projects: [], roots: [] };
const EMPTY: RepoSnapshot = { gitDir: false, config: [], hooks: {}, redirects: [], commands: {} };
const MAX_ROOT_PROJECTS = 2000;

/** The folders directly inside a project root (plain folders only; links are never followed). */
const rootProjects = (root: string): string[] => {
  if (!dirExists(root) || isLink(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).slice(0, MAX_ROOT_PROJECTS).map((e) => path.join(root, e.name));
};
const has = (projects: SavedT[], workspace: string): boolean => projects.some((s) => s.workspace.toLowerCase() === workspace.toLowerCase());

/**
 * At launch: every folder the sandbox will be able to write. The launch folder, projects mapped with it and every
 * project already inside a project root are snapshotted as they are now, before the sandbox can touch them.
 */
export const saveRepoSnapshot = (dataPath: string, workspace: string, more: string[] = [], roots: string[] = []): void => {
  const folders = _.uniqBy([workspace, ...more, ...roots.flatMap((r) => [r, ...rootProjects(r)])], (w) => w.toLowerCase());
  writeJsonAtomic(snapshotFile(dataPath), { projects: folders.map((w) => ({ workspace: w, snapshot: snapshotRepo(w) })), roots });
};

/**
 * A project that joins the running sandbox: snapshotted before its first session, then guarded like the launch
 * folder. A project already guarded keeps its first snapshot (what was there before the sandbox could touch it).
 */
export const addRepoSnapshot = (dataPath: string, workspace: string, o: { empty?: boolean } = {}): void => {
  const store = readStore(dataPath);
  // A folder inside one that is guarded already is covered by it only for its root files; it gets its own entry.
  if (has(store.projects, workspace)) return;
  writeJsonAtomic(snapshotFile(dataPath), { ...store, projects: [...store.projects, { workspace, snapshot: o.empty ? EMPTY : snapshotRepo(workspace) }] });
};

/**
 * Folders that appeared inside a project root after the launch: the sandbox could have written them from the start,
 * so they get an EMPTY baseline: any git hook, git config that runs programs (core.hooksPath, core.fsmonitor, ...)
 * or planted command in them counts as added inside the sandbox and is neutralised.
 */
const discoverRootProjects = (dataPath: string): SavedT[] => {
  const store = readStore(dataPath);
  const found = store.roots.flatMap(rootProjects).filter((w) => !has(store.projects, w)).map((workspace) => ({ workspace, snapshot: EMPTY }));
  if (!found.length) return store.projects;
  const projects = [...store.projects, ...found].slice(0, 4096);
  writeJsonAtomic(snapshotFile(dataPath), { ...store, projects });
  return projects;
};

/** The folders being guarded (for status). */
export const guardedProjects = (dataPath: string): string[] => readStore(dataPath).projects.map((s) => s.workspace);

/** Re-checks every project of the current/last launch; findings are kept in a host-only file for `status`. Returns the new ones. */
export const checkRepo = (dataPath: string): RepoFinding[] => {
  const saved = discoverRootProjects(dataPath);
  if (!saved.length) return [];
  const old = repoFindings(dataPath);
  // A finding that cannot be fixed (a file locked in the sandbox) is reported once, not every minute.
  const findings = saved.flatMap((s) => guardRepo(s.workspace, s.snapshot).map((f) => (saved.length > 1 ? { ...f, detail: s.workspace + ': ' + f.detail } : f)))
    .filter((f) => !old.some((o) => o.kind === f.kind && o.detail === f.detail));
  if (findings.length) writeJsonAtomic(findingsFile(dataPath), [...old, ...findings.map((f) => ({ ...f, at: new Date().toISOString() }))]);
  return findings;
};

export const repoFindings = (dataPath: string): (RepoFinding & { at?: string })[] => readValid(z.array(Finding).max(10000), findingsFile(dataPath)) ?? [];
