// Claude Code managed settings for the sandbox (C:\Program Files\ClaudeCode\managed-settings.json). Managed settings
// have the highest precedence and cannot be overridden by user or project settings, so they carry the hard rules:
// today, the git access mode. Rewritten every boot; removed when there is nothing to enforce.
import fs from 'node:fs';
import path from 'node:path';
import type { GitAccess } from '../../core/types.js';
import { managedClaudeMd } from '../guide.js';

const SHELLS = ['Bash', 'PowerShell'];
const WRITE_COMMANDS = ['commit', 'push', 'add', 'rm', 'mv', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'restore', 'stash', 'tag', 'cherry-pick', 'revert', 'am', 'apply', 'clean', 'pull', 'fetch', 'clone', 'init', 'gc', 'prune', 'update-ref', 'update-index', 'filter-branch', 'replace', 'worktree add', 'branch -d', 'branch -D', 'branch -m', 'branch -M', 'config --add', 'config --unset', 'remote add', 'remote remove', 'remote set-url'];
const GIT_DIR_PATHS = ['**/.git', '**/.git/**'];

export const gitDenyRules = (access: GitAccess): string[] => {
  if (access === 'full') return [];
  const commands = access === 'none' ? ['git'] : WRITE_COMMANDS.map((c) => 'git ' + c);
  const shellRules = SHELLS.flatMap((shell) => commands.map((c) => shell + '(' + c + ':*)'));
  const fileRules = GIT_DIR_PATHS.flatMap((p) => (access === 'none' ? ['Read(' + p + ')', 'Edit(' + p + ')'] : ['Edit(' + p + ')']));
  return [...shellRules, ...fileRules];
};

export const managedSettingsFile = (): string => path.join(path.dirname(managedClaudeMd()), 'managed-settings.json');

export const writeManagedSettings = (access: GitAccess): void => {
  const file = managedSettingsFile();
  const deny = gitDenyRules(access);
  if (deny.length === 0) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions: { deny } }, null, 2) + '\n', 'utf8');
};
