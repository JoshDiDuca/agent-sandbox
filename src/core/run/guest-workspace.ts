// Where the workspace and its extra folders appear inside the sandbox ("auto", "mirror", a project root, a path).
import type { Config, Mapping } from '../types.js';
import {
  autoGuestFolder,
  deriveGuest,
  guestConflict,
  guestFix,
  planMirrorWorkspace,
  PROJECTS_GUEST,
  rootGuestDir,
  tidyGuestPath,
  usableRoots,
} from '../../shared/paths/index.js';
import { dirExists, isInsideOrEqual } from '../util/index.js';

/** 'auto' guest workspace: C:\Workspace\<folder name> (shared/paths/projects.ts, where every project's place is decided). */
export const autoGuestWorkspace = autoGuestFolder;

/**
 * A launch folder inside a project root appears under the root's folder (C:\Projects\<root>\<name>, or its PC path
 * with "mirror"), where it also is when another project started the sandbox, so git worktrees and Claude's project
 * folders keep working whichever project starts it. Only for "auto" / "mirror"; a filtered or read-only workspace
 * keeps its own mapping (the root would show the folder unfiltered and writable at that place).
 */
export function placeInRoot(config: Config, workspaceHost: string, mirror: boolean, notes: string[]): Config {
  const guest = rootGuestDir(usableRoots(config.projects.roots, dirExists), mirror, workspaceHost);
  if (!guest) return config;
  if (config.workspaceFilter.enabled || config.readOnly) {
    notes.push(
      workspaceHost +
        ' is inside a project root, but ' +
        (config.readOnly ? 'readOnly' : 'workspaceFilter') +
        ' is on, so it is mapped on its own at ' +
        config.guestWorkspace +
        ' (when another project starts the sandbox it is at ' +
        guest +
        ').',
    );
    return config;
  }
  return { ...config, guestWorkspace: guest };
}

/** Where the workspace appears: guestWorkspace "auto", "mirror" (with a note when it falls back) or a path. */
export function guestWorkspaceOf(
  config: Pick<Config, 'guestWorkspace'>,
  workspaceHost: string,
): { guest: string; note: string | null } {
  if (config.guestWorkspace === 'auto') return { guest: autoGuestWorkspace(workspaceHost), note: null };
  if (config.guestWorkspace === 'mirror') return planMirrorWorkspace(workspaceHost, autoGuestWorkspace(workspaceHost));
  return { guest: config.guestWorkspace, note: null };
}

/**
 * Where a mapping will most likely appear, before the launch knows every other folder (the prompt and config check
 * show it; the launch places it for real in host/launch/mappings.ts with the same rules).
 */
export function previewGuest(
  m: Pick<Mapping, 'host' | 'guest'>,
  workspaceHost: string,
  workspaceGuest: string,
): { guest: string; note: string | null } {
  const guest = tidyGuestPath(m.guest ?? deriveGuest(m.host, workspaceHost, workspaceGuest));
  const conflict = guestConflict(guest, [
    ...(m.guest || !isInsideOrEqual(workspaceHost, m.host) ? [{ guest: workspaceGuest, what: 'the project' }] : []),
    { guest: PROJECTS_GUEST, what: 'other projects' },
  ]);
  return { guest, note: conflict ? m.host + ': ' + conflict + '. Fix: ' + guestFix(m.guest) : null };
}
