// Which folders besides the launch folder are mapped so other projects can join without a restart: the project
// roots (projects.roots), projects carried over by a restart that added one, and with projects.all every project
// started before (except projects.exclude). Every one passes the same checks as a launch folder.
import path from 'node:path';
import type { ResolvedRun } from '../../core/types.js';
import { assertSafeMapping, assertSafeWorkspace } from '../../core/safe-paths.js';
import { dirExists, errMsg, fail } from '../../core/util/index.js';
import { isWithin, planProjectMappings, type RootMapping } from '../../shared/paths/index.js';
// Direct, not the barrel: host/projects/join.ts imports host/launch.
import { allProjectsToMap, readKnown } from '../projects/known.js';

/** More folders than this would make the .wsb (and every boot) unwieldy; the rest join with a restart later. */
export const MAX_BOOT_PROJECTS = 48;

export interface BootProjects {
  roots: RootMapping[];
  projects: RootMapping[];
  notes: string[];
}

export const planBootProjects = (o: {
  run: ResolvedRun;
  packageRoot: string;
  extraProjects?: string[];
  knownProjects?: string[];
}): BootProjects => {
  const { config, workspaceHost, storageRoot } = o.run;
  const notes: string[] = [];
  const safe = (folder: string): string | null => {
    try {
      assertSafeWorkspace(folder, o.packageRoot, storageRoot);
      assertSafeMapping(folder, o.packageRoot, storageRoot);
      return null;
    } catch (e) {
      return errMsg(e);
    }
  };
  const roots: string[] = [];
  for (const root of config.projects.roots.map((r) => path.resolve(r))) {
    if (!dirExists(root)) {
      notes.push('Project root not found, skipped: ' + root);
      continue;
    }
    const refusal = safe(root);
    if (refusal)
      fail(
        'projects.roots: ' + refusal,
        'Use a folder that holds your projects, e.g. F:\\Code (not a drive, your profile or a system folder).',
      );
    if (!roots.some((r) => isWithin(r, root))) roots.push(root);
  }
  const known = o.knownProjects ?? readKnown(storageRoot).map((k) => k.host);
  const wanted = [
    ...(o.extraProjects ?? []),
    ...(config.projects.all
      ? allProjectsToMap(known, { primary: workspaceHost, roots, exclude: config.projects.exclude })
      : []),
  ];
  const projects: string[] = [];
  for (const folder of wanted.map((p) => path.resolve(p))) {
    if (
      isWithin(workspaceHost, folder) ||
      roots.some((r) => isWithin(r, folder)) ||
      projects.some((p) => isWithin(p, folder) || isWithin(folder, p))
    )
      continue;
    if (!dirExists(folder)) continue;
    const refusal = safe(folder);
    if (refusal) {
      notes.push('Not mapped: ' + refusal);
      continue;
    }
    if (projects.length >= MAX_BOOT_PROJECTS) {
      notes.push(
        'More than ' + MAX_BOOT_PROJECTS + ' projects: the rest are not mapped (a project root holds any number).',
      );
      break;
    }
    projects.push(folder);
  }
  return { ...planProjectMappings(roots, projects, Boolean(o.run.mirror)), notes };
};
