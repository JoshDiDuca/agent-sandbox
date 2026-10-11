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
import { dirExists, fileExists, isLink, tryReadJson, writeJson } from '../core/util.js';

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

const hash = (file: string): string => (isLink(file) ? 'link' : crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
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
  return fileExists(file) && !isLink(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
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
    fs.renameSync(path.join(from, name), path.join(target, name));
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
  if (findings.length) fs.writeFileSync(path.join(dir, 'config'), fixed.join('\n'), 'utf8');
  return findings;
};

/**
 * Compares the workspace with its pre-launch snapshot and neutralises anything new that would execute on this PC.
 * Returns what was found (and fixed). Never touches what was already there before the sandbox ran.
 */
export const guardRepo = (workspace: string, before: RepoSnapshot): RepoFinding[] => {
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

export const saveRepoSnapshot = (dataPath: string, workspace: string): void => writeJson(snapshotFile(dataPath), { workspace, snapshot: snapshotRepo(workspace) });

/** Re-checks the workspace of the current/last launch; findings are kept in a host-only file for `status`. */
export const checkRepo = (dataPath: string): RepoFinding[] => {
  const saved = tryReadJson<{ workspace: string; snapshot: RepoSnapshot }>(snapshotFile(dataPath));
  if (!saved?.snapshot?.commands) return [];
  const findings = guardRepo(saved.workspace, saved.snapshot);
  if (findings.length) writeJson(findingsFile(dataPath), [...repoFindings(dataPath), ...findings.map((f) => ({ ...f, at: new Date().toISOString() }))]);
  return findings;
};

export const repoFindings = (dataPath: string): (RepoFinding & { at?: string })[] => tryReadJson<(RepoFinding & { at?: string })[]>(findingsFile(dataPath)) ?? [];
