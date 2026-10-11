// Several projects in one running sandbox. Windows Sandbox fixes its mapped folders at boot, so a project can only
// join a running sandbox when it is already visible inside:
//  - the launch folder (mapped directly, as always);
//  - a folder inside a project root (projects.roots: whole folders of projects, mapped at every start), including
//    projects created after boot;
//  - projects mapped at boot because they were in use when the sandbox was restarted to add them;
//  - a folder shared into the running sandbox with `wsb share` (Windows 11 24H2+, untested).
// Roots, boot-mapped projects and shares appear under C:\Projects (roots at their PC path with guestWorkspace "mirror").
// Pure functions only: used by the host (registration, commands), the guest (daemon checks) and the tests.
import path from 'node:path';
import { isValidGuestPath } from './guest-paths.js';

/** Where roots, boot-mapped projects and shared folders appear inside the sandbox. */
export const PROJECTS_GUEST = 'C:\\Projects';

/** How a project got into the sandbox. */
export type Mechanism = 'launch' | 'root' | 'boot' | 'wsb';

/** One project the running sandbox works on. */
export interface ProjectEntry { name: string; host: string; guest: string; primary: boolean; mechanism: Mechanism }

const norm = (p: string): string => path.win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** `child` is `parent` or somewhere below it (Windows paths, case-insensitive). */
export const isWithin = (parent: string, child: string): boolean => {
  const a = norm(parent);
  const b = norm(child);
  return a === b || b.startsWith(a.endsWith('\\') ? a : a + '\\');
};

/**
 * A project id (also its folder name under C:\Projects) for a folder: its name with only letters, digits, '-' and
 * '_' (ids become file names on both sides), at most 48 characters, made unique against `taken` with -2, -3, ...
 */
export const hubName = (hostDir: string, taken: Iterable<string>): string => {
  const base = path.win32.basename(path.win32.resolve(hostDir)).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!used.has((base + '-' + i).toLowerCase())) return base + '-' + i;
};

/** The project a folder on this PC belongs to: the most specific one that contains it (a project inside another wins). */
export const projectForHostDir = <P extends { host: string }>(projects: P[], hostDir: string): P | null =>
  projects.filter((p) => isWithin(p.host, hostDir)).sort((a, b) => b.host.length - a.host.length)[0] ?? null;

/** The same for a folder inside the sandbox. */
export const projectForGuestDir = <P extends { guest: string }>(projects: P[], guestDir: string): P | null =>
  projects.filter((p) => isWithin(p.guest, guestDir)).sort((a, b) => b.guest.length - a.guest.length)[0] ?? null;

/** Where a folder on this PC appears inside the sandbox, given the mapped folder (project or root) that contains it. */
export const guestDirFor = (mapped: { host: string; guest: string }, hostDir: string): string => {
  const rel = path.win32.relative(path.win32.resolve(mapped.host), path.win32.resolve(hostDir));
  return rel ? path.win32.join(mapped.guest, rel) : mapped.guest;
};

/** The other way: where a folder inside the sandbox is on this PC, given the mapped folder that contains it. */
export const hostDirFor = (mapped: { host: string; guest: string }, guestDir: string): string => {
  const rel = path.win32.relative(path.win32.resolve(mapped.guest), path.win32.resolve(guestDir));
  return rel ? path.win32.join(mapped.host, rel) : mapped.host;
};

/** Strictly below `parent` (never `parent` itself). */
export const isBelow = (parent: string, child: string): boolean => isWithin(parent, child) && norm(parent) !== norm(child);

/** A guest folder some project can be in: below C:\Projects, or inside one of the roots (their guest paths). */
export const insideProjects = (guestDir: string, roots: string[] = [], projectsDir = PROJECTS_GUEST): boolean =>
  isBelow(projectsDir, guestDir) || roots.some((r) => isWithin(r, guestDir));

export interface RootMapping { host: string; guest: string }

/**
 * Guest folders for the project roots and the projects mapped at boot: C:\Projects\<name>, unique; with
 * guestWorkspace "mirror" a root appears at its PC path when the sandbox can show it there.
 */
export const planProjectMappings = (roots: string[], projects: string[], mirror: boolean, taken: string[] = []): { roots: RootMapping[]; projects: RootMapping[] } => {
  const names = [...taken];
  const place = (host: string, tryMirror: boolean): RootMapping => {
    const resolved = path.win32.resolve(host).replace(/[\\/]+$/, '');
    if (tryMirror && isValidGuestPath(resolved) && !isWithin(PROJECTS_GUEST, resolved)) return { host: resolved, guest: resolved };
    const name = hubName(resolved, names);
    names.push(name);
    return { host: resolved, guest: path.win32.join(PROJECTS_GUEST, name) };
  };
  return { roots: roots.map((r) => place(r, mirror)), projects: projects.map((p) => place(p, false)) };
};
