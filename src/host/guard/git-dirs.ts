// A git folder's hooks, config and redirect files, and the rule that guards the project's own .git.
import fs from 'node:fs';
import path from 'node:path';
import { dirExists, isLink } from '../../core/util/index.js';
import { filesIn } from './file-hash.js';
import { configLines, disableConfig } from './git-config.js';
import { quarantine } from './quarantine.js';
import type { GitState, GuardRule, RepoFinding, RepoSnapshot } from './types.js';

/** Files in .git that make git read config/hooks from somewhere else. */
const REDIRECTS = ['commondir', 'config.worktree'] as const;
const isHook = (name: string): boolean => !name.endsWith('.sample');

export const EMPTY_GIT: GitState = { config: [], hooks: {}, redirects: [] };

/** <workspace>\.git when it is a real folder (not a link or a "gitdir:" file). */
export function plainGitDir(workspace: string): string | null {
  const dir = path.join(workspace, '.git');
  return dirExists(dir) && !isLink(dir) ? dir : null;
}

export function gitState(dir: string | null): GitState {
  return {
    config: dir ? configLines(dir) : [],
    hooks: dir ? filesIn(path.join(dir, 'hooks'), isHook) : {},
    redirects: dir ? REDIRECTS.filter((n) => fs.existsSync(path.join(dir, n))) : [],
  };
}

/** New or changed hooks and new redirect files are quarantined; new config that runs programs is commented out. */
export function guardGitDir(dir: string, before: GitState): RepoFinding[] {
  const hooksDir = path.join(dir, 'hooks');
  const hooksNow = filesIn(hooksDir, isHook);
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
}

/** The project's own .git; a .git replaced by a link or a "gitdir:" file is reported, never followed. */
export class GitDirRule implements GuardRule {
  readonly kind = 'git-dir';

  check(workspace: string, before: RepoSnapshot): RepoFinding[] {
    const dir = plainGitDir(workspace);
    if (dir) return guardGitDir(dir, before);
    const replaced = before.gitDir && fs.existsSync(path.join(workspace, '.git'));
    if (!replaced) return [];
    return [
      {
        kind: 'git',
        detail:
          '.git was replaced by a link or a "gitdir:" file inside the sandbox. Do not run git in ' +
          workspace +
          ' until you have checked it.',
      },
    ];
  }
}
