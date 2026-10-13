import fs from 'node:fs';
import path from 'node:path';
import { dirExists, fileExists, isLink } from '../../core/util/index.js';
import { hash } from './file-hash.js';
import type { GitState, RepoFinding } from './repo-guard.js';
import { configLines, disableConfig } from './git-config.js';
import { quarantine } from './quarantine.js';

/** Files in .git that make git read config/hooks from somewhere else. */
const REDIRECTS = ['commondir', 'config.worktree'];
export const plainGitDir = (workspace: string): string | null => {
  const dir = path.join(workspace, '.git');
  return dirExists(dir) && !isLink(dir) ? dir : null;
};

export const filesIn = (dir: string, accept: (name: string) => boolean): Record<string, string> =>
  dirExists(dir) && !isLink(dir)
    ? Object.fromEntries(
        fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => (e.isFile() || e.isSymbolicLink()) && accept(e.name))
          .map((e) => [e.name, hash(path.join(dir, e.name))]),
      )
    : {};

export const gitState = (dir: string | null): GitState => ({
  config: dir ? configLines(dir) : [],
  hooks: dir ? filesIn(path.join(dir, 'hooks'), (n) => !n.endsWith('.sample')) : {},
  redirects: dir ? REDIRECTS.filter((n) => fs.existsSync(path.join(dir, n))) : [],
});
export const EMPTY_GIT: GitState = { config: [], hooks: {}, redirects: [] };

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
export const otherGitDirs = (workspace: string): string[] => {
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

export const guardGitDir = (dir: string, before: GitState): RepoFinding[] => {
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
