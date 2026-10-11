// Zero-click protection for the git repository the sandbox shares with this PC.
//
// The agent can write the workspace, including .git. A new hook (.git/hooks/post-checkout, ...) or a config key such
// as core.fsmonitor / core.sshCommand / core.pager / a filter driver / include.path would run code on THIS PC the
// next time you run an ordinary git command here. So: snapshot before launch, re-check while the sandbox runs and
// when it closes; quarantine new or changed hooks and comment out newly added dangerous config keys.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { dirExists, fileExists, isLink, tryReadJson, writeJson } from '../core/util.js';

/** Config keys that make git run a program. Matched against `key = value` lines (section-independent on purpose). */
const DANGEROUS_KEY = /^\s*(fsmonitor|hookspath|sshcommand|pager|editor|askpass|program|gpgprogram|textconv|command|cmd|clean|smudge|process|driver|helper|uploadpack|receivepack|path|attributesfile|excludesfile|worktree|gitproxy|proxycommand|sendemailvalidate|tool)\s*=/i;
const SECTION_INCLUDE = /^\s*\[\s*include(if\s+"[^"]*")?\s*\]/i;
const MARK = '# [agent-sandbox] disabled, added inside the sandbox: ';

export interface RepoSnapshot { config: string[]; hooks: Record<string, string> }
export interface RepoFinding { kind: 'hook' | 'config'; detail: string }

const gitDir = (workspace: string): string | null => {
  const dir = path.join(workspace, '.git');
  return dirExists(dir) && !isLink(dir) ? dir : null;
};

const hash = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const activeHooks = (dir: string): Record<string, string> => {
  const hooks = path.join(dir, 'hooks');
  if (!dirExists(hooks) || isLink(hooks)) return {};
  return Object.fromEntries(fs.readdirSync(hooks).filter((n) => !n.endsWith('.sample')).map((n) => path.join(hooks, n)).filter((p) => fs.lstatSync(p).isFile() || fs.lstatSync(p).isSymbolicLink()).map((p) => [path.basename(p), fs.lstatSync(p).isSymbolicLink() ? 'link' : hash(p)]));
};

const configLines = (dir: string): string[] => {
  const file = path.join(dir, 'config');
  return fileExists(file) && !isLink(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
};

export const snapshotRepo = (workspace: string): RepoSnapshot | null => {
  const dir = gitDir(workspace);
  return dir ? { config: configLines(dir), hooks: activeHooks(dir) } : null;
};

/**
 * Compares the repository with its pre-launch snapshot and neutralises anything new that would execute on this PC.
 * Returns what was found (and fixed). Never touches lines or hooks that were already there before the sandbox ran.
 */
export const guardRepo = (workspace: string, before: RepoSnapshot): RepoFinding[] => {
  const dir = gitDir(workspace);
  if (!dir) return [];
  const findings: RepoFinding[] = [];

  const hooksNow = activeHooks(dir);
  const changedHooks = Object.keys(hooksNow).filter((name) => before.hooks[name] !== hooksNow[name]);
  if (changedHooks.length) {
    const quarantine = path.join(dir, 'agent-sandbox-quarantine', String(Date.now()));
    fs.mkdirSync(quarantine, { recursive: true });
    for (const name of changedHooks) {
      fs.renameSync(path.join(dir, 'hooks', name), path.join(quarantine, name));
      findings.push({ kind: 'hook', detail: name + ' (moved to ' + quarantine + ')' });
    }
  }

  const lines = configLines(dir);
  const known = _.countBy(before.config);
  const seen: Record<string, number> = {};
  let inInclude = false;
  let changed = false;
  const fixed = lines.map((line) => {
    if (/^\s*\[/.test(line)) inInclude = SECTION_INCLUDE.test(line);
    seen[line] = (seen[line] ?? 0) + 1;
    const isNew = seen[line] > (known[line] ?? 0);
    if (!isNew || line.startsWith(MARK) || !(DANGEROUS_KEY.test(line) || (inInclude && /=/.test(line)))) return line;
    changed = true;
    findings.push({ kind: 'config', detail: line.trim() });
    return MARK + line.trim();
  });
  if (changed) fs.writeFileSync(path.join(dir, 'config'), fixed.join('\n'), 'utf8');
  return findings;
};

// ---- snapshot storage (host-only, next to the sync state) ---------------------------------------------------------

const snapshotFile = (dataPath: string): string => path.join(path.dirname(path.dirname(dataPath)), 'sync', path.basename(dataPath) + '-repo.json');
const findingsFile = (dataPath: string): string => path.join(path.dirname(path.dirname(dataPath)), 'sync', path.basename(dataPath) + '-repo-findings.json');

export const saveRepoSnapshot = (dataPath: string, workspace: string): void => writeJson(snapshotFile(dataPath), { workspace, snapshot: snapshotRepo(workspace) });

/** Re-checks the repository of the current/last launch; findings are appended to a host-only log for `status`. */
export const checkRepo = (dataPath: string): RepoFinding[] => {
  const saved = tryReadJson<{ workspace: string; snapshot: RepoSnapshot | null }>(snapshotFile(dataPath));
  if (!saved?.snapshot) return [];
  const findings = guardRepo(saved.workspace, saved.snapshot);
  if (findings.length) writeJson(findingsFile(dataPath), [...repoFindings(dataPath), ...findings.map((f) => ({ ...f, at: new Date().toISOString() }))]);
  return findings;
};

export const repoFindings = (dataPath: string): (RepoFinding & { at?: string })[] => tryReadJson<(RepoFinding & { at?: string })[]>(findingsFile(dataPath)) ?? [];
