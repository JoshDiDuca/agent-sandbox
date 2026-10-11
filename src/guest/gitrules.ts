// Claude permission rules for each git access mode. Pure (no environment, no I/O), so the host and the tests can
// import it without loading the guest runtime.
import type { GitAccess } from '../core/types.js';

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
