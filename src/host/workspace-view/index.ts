// workspaceFilter in practice: which view a launch maps instead of the project, the project's .git mapped beside it,
// and the host-only list of views the background watcher keeps in step while the sandbox runs.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../../core/types.js';
import { readValid, writeJsonAtomic } from '../../shared/rundir.js';
import { WorkspaceView, type ViewOptions } from './view.js';

export { IgnoreRules } from './rules.js';
export { WorkspaceView, type SyncStats, type ViewOptions } from './view.js';

/** The project's .git as the sandbox sees it: next to the workspace (C:\Workspace\app -> C:\Workspace\app.git). */
export const guestGitDir = (guestWorkspace: string): string => guestWorkspace.replace(/[\\/]+$/, '') + '.git';

export interface ViewPlan {
  options: ViewOptions;
  /** The project's real .git folder, mapped at options.guestGitDir (null: none). */ hostGit: string | null;
  note?: string;
}

/**
 * The view for a launch, or null when the folder itself is mapped: workspaceFilter off, or a git worktree (its .git is
 * a file pointing elsewhere, which a view cannot follow; then the folder is mapped as before and a note says so).
 */
export const planView = (config: Config, storageRoot: string, workspaceHost: string): ViewPlan | null => {
  if (!config.workspaceFilter.enabled) return null;
  const git = path.join(workspaceHost, '.git');
  let gitIsDir = false;
  try {
    const s = fs.lstatSync(git);
    if (s.isFile()) return null;
    gitIsDir = s.isDirectory() && !s.isSymbolicLink();
  } catch {
    /* no .git */
  }
  // git access "none": the agent gets no .git at all.
  const hostGit = gitIsDir && config.provisioning.git.enabled && config.provisioning.git.access !== 'none' ? git : null;
  return {
    options: {
      ...WorkspaceView.pathsFor(storageRoot, workspaceHost),
      exclude: config.workspaceFilter.exclude,
      include: config.workspaceFilter.include,
      guestGitDir: hostGit ? guestGitDir(config.guestWorkspace) : null,
    },
    hostGit,
  };
};

/** Why a filtered launch maps the folder itself after all (for the launch notes). */
export const viewSkipped = (config: Config, workspaceHost: string): string | null => {
  if (!config.workspaceFilter.enabled) return null;
  try {
    if (fs.lstatSync(path.join(workspaceHost, '.git')).isFile())
      return (
        'workspaceFilter: ' +
        workspaceHost +
        ' is a git worktree (.git is a file); the folder is mapped as it is, git-ignored files included.'
      );
  } catch {
    /* fine */
  }
  return null;
};

// ---- the views the watcher keeps in step (host-only, next to the sync state) ------------------------------------------

const ActiveView = z.object({
  host: z.string().max(1024),
  view: z.string().max(1024),
  state: z.string().max(1024),
  exclude: z.array(z.string().max(500)).max(500),
  include: z.array(z.string().max(500)).max(500),
  guestGitDir: z.string().max(1024).nullable(),
});
const activeFile = (storageRoot: string, dataPath: string): string =>
  path.join(storageRoot, 'sync', path.basename(dataPath) + '-views.json');

export const saveActiveViews = (storageRoot: string, dataPath: string, views: ViewOptions[]): void =>
  writeJsonAtomic(
    activeFile(storageRoot, dataPath),
    views.map((v) => ({
      host: v.host,
      view: v.view,
      state: v.state,
      exclude: v.exclude ?? [],
      include: v.include ?? [],
      guestGitDir: v.guestGitDir ?? null,
    })),
  );

export const readActiveViews = (storageRoot: string, dataPath: string): ViewOptions[] =>
  readValid(z.array(ActiveView).max(64), activeFile(storageRoot, dataPath)) ?? [];
