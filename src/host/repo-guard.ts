// Zero-click protection for the folder the sandbox shares with this PC.
//
// The agent can write the workspace. Two kinds of change there would run code on THIS PC without you doing anything
// unusual, so they are snapshotted before launch, re-checked every minute while the sandbox runs and when it closes,
// and neutralised:
//  - git: new or changed hooks, and config that makes git run programs (core.fsmonitor, core.sshCommand, filters,
//    include.path, ...), plus files that redirect where git reads config and hooks (commondir, config.worktree);
//  - commands: executables dropped in the project root under the name of something you type there (node.exe,
//    git.cmd, npm.cmd, ...), because Windows runs a program from the current folder before searching PATH;
//  - agent and editor files: hooks, helper commands and MCP servers in .claude/ and .mcp.json, VS Code folder-open
//    tasks and program paths, .envrc. Submodules and nested repositories get the git checks too.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { z } from 'zod';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { readValid, writeFileAtomic, writeJsonAtomic } from '../shared/io/index.js';
import { assertTestWritable } from './test-guard.js';
import { dirExists, fileExists, isLink } from '../core/util/index.js';

/** Config keys that make git run a program, or load more config. */
const DANGEROUS_KEY =
  /^(fsmonitor|hookspath|sshcommand|pager|editor|askpass|program|gpgprogram|textconv|command|cmd|clean|smudge|process|driver|helper|uploadpack|receivepack|path|attributesfile|excludesfile|worktree|worktreeconfig|gitproxy|proxycommand|sendemailvalidate|tool|external|difffilter|defaultkeycommand|alternaterefscommand)\s*=/i;
/** Sections where any key runs a program ([pager] log = x), or where a "!" value does ([alias] st = !x). */
const dangerousInSection = (section: string, keyPart: string): boolean =>
  (section === 'pager' && keyPart.includes('=')) || (section === 'alias' && /^[^=]+=\s*"?\s*!/.test(keyPart));
const SECTION = /^\s*\[([^\]]*)\]\s*/;
const MARK = '# [agent-sandbox] disabled, added inside the sandbox: ';
/** Files in .git that make git read config/hooks from somewhere else. */
const REDIRECTS = ['commondir', 'config.worktree'];
/** Names you are likely to run in a project folder; with any of these extensions Windows would pick the local copy. */
const COMMANDS = new RegExp(
  '^(' +
    [
      // this tool's own commands (package.json "bin")
      'sandbox',
      'windows-development-sandbox',
      'agent-sandbox',
      'claude-sbx',
      'claude-sandbox',
      'codex-sbx',
      'codex-sandbox',
      'gemini-sbx',
      'gemini-sandbox',
      'claude-host',
      'sbx-show',
      'sbx-hide',
      // agents
      'claude',
      'codex',
      'gemini',
      'opencode',
      'qwen',
      'crush',
      'copilot',
      'kilo',
      'kilocode',
      'amp',
      'cline',
      'cn',
      'kimi',
      'reasonix',
      'codewhale',
      'aider',
      'cursor-agent',
      'agent',
      'goose',
      // toolchains and everyday tools
      'node',
      'npm',
      'npx',
      'pnpm',
      'pnpx',
      'yarn',
      'corepack',
      'volta',
      'nvm',
      'deno',
      'bun',
      'bunx',
      'tsc',
      'git',
      'gh',
      'code',
      'python',
      'python3',
      'py',
      'pip',
      'pip3',
      'uv',
      'uvx',
      'pyenv',
      'poetry',
      'cargo',
      'rustc',
      'rustup',
      'dotnet',
      'nuget',
      'msbuild',
      'go',
      'java',
      'javac',
      'mvn',
      'mvnw',
      'gradle',
      'gradlew',
      'ruby',
      'gem',
      'bundle',
      'rake',
      'rails',
      'php',
      'composer',
      'make',
      'cmake',
      'ninja',
      'gcc',
      'g\\+\\+',
      'clang',
      'psql',
      'mysql',
      'mariadb',
      'mongosh',
      'redis-cli',
      'docker',
      'kubectl',
      'terraform',
      'az',
      'aws',
      'powershell',
      'pwsh',
      'cmd',
      'where',
      'tasklist',
      'tar',
      'curl',
      'ssh',
      'scp',
    ].join('|') +
    ')\\.(exe|com|bat|cmd|vbs|vbe|js|jse|wsf|wsh|msc|ps1)$',
  'i',
);

/**
 * Project files that tools on this PC act on by themselves: Claude Code runs a project's hooks, helpers and MCP servers,
 * VS Code runs folder-open tasks and the programs workspace settings point at, direnv runs .envrc. For each, only the
 * part that can run something is compared (`risky`), so the agent may still edit the rest (permissions, formatting).
 */
const AGENT_FILES: Record<string, (data: unknown, text: string) => unknown> = {
  '.claude/settings.json': (d) => claudeRisk(d),
  '.claude/settings.local.json': (d) => claudeRisk(d),
  '.mcp.json': (_d, text) => text,
  '.vscode/tasks.json': (d) => (JSON.stringify(d).match(/"runOn"\s*:\s*"folderOpen"/) ? d : null),
  '.vscode/settings.json': (d) =>
    _.pickBy(_.isPlainObject(d) ? (d as object) : {}, (_v, k) =>
      /path|executable|command|interpreter|shell|profile|args|env|exec|program|server|launch|runtime|binary/i.test(k),
    ),
  '.envrc': (_d, text) => text,
};
const claudeRisk = (d: unknown): unknown => {
  const s = (_.isPlainObject(d) ? d : {}) as Record<string, unknown>;
  const permissions = (_.isPlainObject(s.permissions) ? s.permissions : {}) as Record<string, unknown>;
  return {
    ..._.pick(s, [
      'hooks',
      'apiKeyHelper',
      'awsAuthRefresh',
      'awsCredentialExport',
      'otelHeadersHelper',
      'statusLine',
      'env',
      'enableAllProjectMcpServers',
      'enabledMcpjsonServers',
      'disableAllHooks',
    ]),
    permissions: _.pick(permissions, ['defaultMode', 'additionalDirectories']),
  };
};
const MAX_AGENT_FILE_BYTES = 1024 * 1024;

/** What can run in one agent file, as a short fingerprint (null = the file is not there). */
const agentRisk = (workspace: string, rel: string): string | null => {
  const file = path.join(workspace, ...rel.split('/'));
  if (!fs.existsSync(file)) return null;
  if (isLink(file) || isLink(path.dirname(file)) || !fileExists(file)) return 'link-or-not-a-file';
  if (fs.statSync(file).size > MAX_AGENT_FILE_BYTES) return 'too-large-' + hash(file);
  const text = fs.readFileSync(file, 'utf8');
  const errors: ParseError[] = [];
  const data = parseJsonc(text, errors, { allowTrailingComma: true });
  const risk = AGENT_FILES[rel](rel === '.envrc' ? null : data, text);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(risk ?? null) + (errors.length && rel !== '.envrc' && rel !== '.mcp.json' ? hash(file) : ''))
    .digest('hex');
};
const agentSnapshot = (workspace: string): Record<string, string> =>
  Object.fromEntries(
    Object.keys(AGENT_FILES).flatMap((rel) => {
      const r = agentRisk(workspace, rel);
      return r ? [[rel, r]] : [];
    }),
  );

/** A git folder's own state: config lines, hooks, redirect files. */
export interface GitState {
  config: string[];
  hooks: Record<string, string>;
  redirects: string[];
}
export interface RepoSnapshot extends GitState {
  gitDir: boolean;
  commands: Record<string, string>;
  /** Fingerprints of AGENT_FILES (missing in snapshots of older versions: then they are not checked). */
  agent?: Record<string, string>;
  /** Other git folders: submodules (.git/modules/...) and repositories nested in the project, by relative path. */
  repos?: Record<string, GitState>;
}
export interface RepoFinding {
  kind: 'hook' | 'config' | 'git' | 'command' | 'agent';
  detail: string;
}

/** SHA-256 in small chunks: a sandbox can plant a multi-gigabyte "node.exe" to exhaust this PC's memory. */
const hash = (file: string): string => {
  if (isLink(file)) return 'link';
  const sum = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1 << 20);
  let fd: number;
  // A file that cannot be read (locked by a program in the sandbox) never matches the snapshot, so it is dealt with.
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return 'unreadable-' + crypto.randomBytes(4).toString('hex');
  }
  try {
    for (
      let n = fs.readSync(fd, buffer, 0, buffer.length, null);
      n > 0;
      n = fs.readSync(fd, buffer, 0, buffer.length, null)
    )
      sum.update(buffer.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return sum.digest('hex');
};
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const plainGitDir = (workspace: string): string | null => {
  const dir = path.join(workspace, '.git');
  return dirExists(dir) && !isLink(dir) ? dir : null;
};

const filesIn = (dir: string, accept: (name: string) => boolean): Record<string, string> =>
  dirExists(dir) && !isLink(dir)
    ? Object.fromEntries(
        fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => (e.isFile() || e.isSymbolicLink()) && accept(e.name))
          .map((e) => [e.name, hash(path.join(dir, e.name))]),
      )
    : {};

const configLines = (dir: string): string[] => {
  const file = path.join(dir, 'config');
  return fileExists(file) && !isLink(file) && fs.statSync(file).size <= MAX_CONFIG_BYTES
    ? fs.readFileSync(file, 'utf8').split(/\r?\n/)
    : [];
};

const gitState = (dir: string | null): GitState => ({
  config: dir ? configLines(dir) : [],
  hooks: dir ? filesIn(path.join(dir, 'hooks'), (n) => !n.endsWith('.sample')) : {},
  redirects: dir ? REDIRECTS.filter((n) => fs.existsSync(path.join(dir, n))) : [],
});
const EMPTY_GIT: GitState = { config: [], hooks: {}, redirects: [] };

const MAX_OTHER_REPOS = 64;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'agent-sandbox-quarantine',
  'target',
  'dist',
  'build',
  'bin',
  'obj',
  '.venv',
  'venv',
]);
const plainDirs = (dir: string, limit: number): string[] => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .slice(0, limit)
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
};
/**
 * Git folders other than the project's own: submodules (.git/modules/**) and repositories nested up to two levels deep.
 * git runs their hooks and config too (git status in a subfolder, VS Code's repository scan). Bounded: links are never
 * followed and at most MAX_OTHER_REPOS are looked at.
 */
const otherGitDirs = (workspace: string): string[] => {
  const found: string[] = [];
  const main = plainGitDir(workspace);
  // Submodules: a folder with a config and a HEAD is a git folder, and may have modules of its own.
  const walk = (dir: string, depth: number): void => {
    for (const d of plainDirs(dir, 200)) {
      if (found.length >= MAX_OTHER_REPOS) return;
      if (fileExists(path.join(d, 'config')) && fileExists(path.join(d, 'HEAD'))) {
        found.push(d);
        if (depth < 3) walk(path.join(d, 'modules'), depth + 1);
      } else if (depth < 3) walk(d, depth + 1);
    }
  };
  if (main) walk(path.join(main, 'modules'), 0);
  for (const sub of plainDirs(workspace, 500).filter((d) => !SKIP_DIRS.has(path.basename(d).toLowerCase()))) {
    for (const candidate of [
      sub,
      ...plainDirs(sub, 200).filter((d) => !SKIP_DIRS.has(path.basename(d).toLowerCase())),
    ]) {
      if (found.length >= MAX_OTHER_REPOS) return found;
      const git = plainGitDir(candidate);
      if (git) found.push(git);
    }
  }
  return found;
};
const relative = (workspace: string, dir: string): string => path.relative(workspace, dir).split(path.sep).join('/');

export const snapshotRepo = (workspace: string): RepoSnapshot => {
  const dir = plainGitDir(workspace);
  return {
    gitDir: dir !== null,
    ...gitState(dir),
    commands: filesIn(workspace, (n) => COMMANDS.test(n)),
    agent: agentSnapshot(workspace),
    repos: Object.fromEntries(otherGitDirs(workspace).map((d) => [relative(workspace, d), gitState(d)])),
  };
};

/** Moves files into <dir>\agent-sandbox-quarantine\<time>\ and reports them. */
const quarantine = (from: string, names: string[], into: string, kind: RepoFinding['kind']): RepoFinding[] => {
  if (names.length === 0) return [];
  const target = path.join(into, 'agent-sandbox-quarantine', String(Date.now()));
  fs.mkdirSync(target, { recursive: true });
  return names.map((name) => {
    try {
      fs.renameSync(path.join(from, name), path.join(target, name));
    } catch (e) {
      return {
        kind,
        detail:
          name +
          ' (could not be moved: ' +
          (e as NodeJS.ErrnoException).code +
          '; delete it yourself before running anything here)',
      };
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
  let section = '';
  const fixed = lines.map((line) => {
    const header = SECTION.exec(line);
    if (header) {
      section = header[1].trim().toLowerCase().split(/\s/)[0];
      inInclude = /^include(if\s+"[^"]*")?$/i.test(header[1].trim());
    }
    seen[line] = (seen[line] ?? 0) + 1;
    if (line.startsWith(MARK) || seen[line] <= (known[line] ?? 0)) return line;
    // git also accepts "[core] fsmonitor = x" on one line, so look past a leading section header.
    const keyPart = line.replace(SECTION, '').trim();
    if (!(DANGEROUS_KEY.test(keyPart) || (inInclude && keyPart.includes('=')) || dangerousInSection(section, keyPart)))
      return line;
    findings.push({ kind: 'config', detail: line.trim() });
    return MARK + line.trim();
  });
  if (findings.length) writeFileAtomic(path.join(dir, 'config'), fixed.join('\n'));
  const file = path.join(dir, 'config');
  // A link or a huge file is not read at all, so say so instead of letting it pass as "nothing found".
  const unchecked = isLink(file)
    ? '.git/config is a link'
    : lines.length === 0 && fileExists(file) && fs.statSync(file).size > MAX_CONFIG_BYTES
      ? '.git/config is over 4 MB'
      : null;
  if (unchecked)
    findings.push({
      kind: 'git',
      detail: unchecked + ', so it cannot be checked. Do not run git in this folder until you have looked at it.',
    });
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
  findings.push(
    ...quarantine(
      workspace,
      Object.keys(commandsNow).filter((n) => before.commands[n] !== commandsNow[n]),
      workspace,
      'command',
    ),
  );

  // Snapshots from before these checks existed have no baseline: checking against nothing would move your own files.
  if (before.agent) findings.push(...guardAgentFiles(workspace, before.agent));
  if (before.repos) {
    for (const other of otherGitDirs(workspace)) {
      const rel = relative(workspace, other);
      findings.push(
        ...guardGitDir(other, before.repos[rel] ?? EMPTY_GIT).map((f) => ({ ...f, detail: rel + ': ' + f.detail })),
      );
    }
  }

  const dir = plainGitDir(workspace);
  if (!dir) {
    const replaced = before.gitDir && fs.existsSync(path.join(workspace, '.git'));
    if (replaced)
      findings.push({
        kind: 'git',
        detail:
          '.git was replaced by a link or a "gitdir:" file inside the sandbox. Do not run git in ' +
          workspace +
          ' until you have checked it.',
      });
    return findings;
  }
  findings.push(...guardGitDir(dir, before));
  return findings;
};

const guardGitDir = (dir: string, before: GitState): RepoFinding[] => {
  const hooksDir = path.join(dir, 'hooks');
  const hooksNow = filesIn(hooksDir, (n) => !n.endsWith('.sample'));
  return [
    ...quarantine(
      hooksDir,
      Object.keys(hooksNow).filter((n) => before.hooks[n] !== hooksNow[n]),
      dir,
      'hook',
    ),
    ...quarantine(
      dir,
      REDIRECTS.filter((n) => fs.existsSync(path.join(dir, n)) && !before.redirects.includes(n)),
      dir,
      'git',
    ),
    ...disableConfig(dir, before.config),
  ];
};

/** Agent files whose runnable part changed are moved to the quarantine folder (the rest of your edits are in there too). */
const guardAgentFiles = (workspace: string, before: Record<string, string>): RepoFinding[] => {
  const changed = Object.keys(AGENT_FILES).filter((rel) => {
    const now = agentRisk(workspace, rel);
    return now !== null && now !== before[rel];
  });
  if (!changed.length) return [];
  const target = path.join(workspace, 'agent-sandbox-quarantine', String(Date.now()));
  fs.mkdirSync(target, { recursive: true });
  return changed.map((rel) => {
    const what =
      rel + ' (the sandbox added something it would run on this PC: hooks, MCP servers, helper commands or tasks';
    try {
      fs.renameSync(path.join(workspace, ...rel.split('/')), path.join(target, rel.replace(/\//g, '_')));
    } catch (e) {
      return {
        kind: 'agent' as const,
        detail:
          what +
          '; could not be moved: ' +
          (e as NodeJS.ErrnoException).code +
          '. Check it before you open this folder in Claude Code or VS Code)',
      };
    }
    return { kind: 'agent' as const, detail: what + '; moved to ' + target + ')' };
  });
};

// ---- snapshot storage (host-only, next to the sync state) ---------------------------------------------------------

const syncDir = (dataPath: string): string => path.join(path.dirname(path.dirname(dataPath)), 'sync');
const snapshotFile = (dataPath: string): string => path.join(syncDir(dataPath), path.basename(dataPath) + '-repo.json');
const findingsFile = (dataPath: string): string =>
  path.join(syncDir(dataPath), path.basename(dataPath) + '-repo-findings.json');

const Finding = z.object({
  kind: z.enum(['hook', 'config', 'git', 'command', 'agent']),
  detail: z.string().max(4096),
  at: z.string().max(64).optional(),
});
const GitStateSchema = z.object({
  config: z.array(z.string()),
  hooks: z.record(z.string(), z.string()),
  redirects: z.array(z.string()),
});
const Saved = z.object({
  workspace: z
    .string()
    .max(1024)
    .refine((p) => path.isAbsolute(p)),
  snapshot: GitStateSchema.extend({
    gitDir: z.boolean(),
    commands: z.record(z.string(), z.string()),
    agent: z.record(z.string(), z.string()).optional(),
    repos: z.record(z.string(), GitStateSchema).optional(),
  }),
});

/**
 * Every project the sandbox can write, and the project roots (whole folders of projects) it has mapped. Older
 * versions saved a single object.
 */
type SavedT = z.output<typeof Saved>;
const Store = z.strictObject({
  projects: z.array(Saved).max(4096),
  roots: z
    .array(
      z
        .string()
        .max(1024)
        .refine((p) => path.isAbsolute(p)),
    )
    .max(64),
});
const StoreAny = z.union([Store, Saved.transform((s) => ({ projects: [s], roots: [] as string[] }))]);
const readStore = (dataPath: string): z.output<typeof Store> =>
  readValid(StoreAny, snapshotFile(dataPath)) ?? { projects: [], roots: [] };
const EMPTY: RepoSnapshot = { gitDir: false, config: [], hooks: {}, redirects: [], commands: {}, agent: {}, repos: {} };
const MAX_ROOT_PROJECTS = 2000;

/** The folders directly inside a project root (plain folders only; links are never followed). */
const rootProjects = (root: string): string[] => {
  if (!dirExists(root) || isLink(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .slice(0, MAX_ROOT_PROJECTS)
    .map((e) => path.join(root, e.name));
};
const has = (projects: SavedT[], workspace: string): boolean =>
  projects.some((s) => s.workspace.toLowerCase() === workspace.toLowerCase());

/**
 * At launch: every folder the sandbox will be able to write. The launch folder, projects mapped with it and every
 * project already inside a project root are snapshotted as they are now, before the sandbox can touch them.
 */
export const saveRepoSnapshot = (
  dataPath: string,
  workspace: string,
  more: string[] = [],
  roots: string[] = [],
): void => {
  const folders = _.uniqBy([workspace, ...more, ...roots.flatMap((r) => [r, ...rootProjects(r)])], (w) =>
    w.toLowerCase(),
  );
  writeJsonAtomic(snapshotFile(dataPath), {
    projects: folders.map((w) => ({ workspace: w, snapshot: snapshotRepo(w) })),
    roots,
  });
};

/**
 * A project that joins the running sandbox: snapshotted before its first session, then guarded like the launch
 * folder. A project already guarded keeps its first snapshot (what was there before the sandbox could touch it).
 */
export const addRepoSnapshot = (dataPath: string, workspace: string, o: { empty?: boolean } = {}): void => {
  const store = readStore(dataPath);
  // A folder inside one that is guarded already is covered by it only for its root files; it gets its own entry.
  if (has(store.projects, workspace)) return;
  writeJsonAtomic(snapshotFile(dataPath), {
    ...store,
    projects: [...store.projects, { workspace, snapshot: o.empty ? EMPTY : snapshotRepo(workspace) }],
  });
};

/**
 * Folders that appeared inside a project root after the launch: the sandbox could have written them from the start,
 * so they get an EMPTY baseline: any git hook, git config that runs programs (core.hooksPath, core.fsmonitor, ...)
 * or planted command in them counts as added inside the sandbox and is neutralised.
 */
const discoverRootProjects = (dataPath: string): SavedT[] => {
  const store = readStore(dataPath);
  const found = store.roots
    .flatMap(rootProjects)
    .filter((w) => !has(store.projects, w))
    .map((workspace) => ({ workspace, snapshot: EMPTY }));
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
  const findings = saved
    .flatMap((s) =>
      guardRepo(s.workspace, s.snapshot).map((f) =>
        saved.length > 1 ? { ...f, detail: s.workspace + ': ' + f.detail } : f,
      ),
    )
    .filter((f) => !old.some((o) => o.kind === f.kind && o.detail === f.detail));
  if (findings.length)
    writeJsonAtomic(findingsFile(dataPath), [...old, ...findings.map((f) => ({ ...f, at: new Date().toISOString() }))]);
  return findings;
};

export const repoFindings = (dataPath: string): (RepoFinding & { at?: string })[] =>
  readValid(z.array(Finding).max(10000), findingsFile(dataPath)) ?? [];
