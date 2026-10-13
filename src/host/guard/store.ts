import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { z } from 'zod';
import { readValid, writeJsonAtomic } from '../../shared/io/index.js';
import { dirExists, isLink } from '../../core/util/index.js';
import { type RepoSnapshot, snapshotRepo, type RepoFinding, guardRepo } from './repo-guard.js';

// ---- snapshot storage (host-only, next to the sync state) ---------------------------------------------------------

const syncDir = (dataPath: string): string => path.join(path.dirname(path.dirname(dataPath)), 'sync');
const snapshotFile = (dataPath: string): string => path.join(syncDir(dataPath), path.basename(dataPath) + '-repo.json');
const findingsFile = (dataPath: string): string =>
  path.join(syncDir(dataPath), path.basename(dataPath) + '-repo-findings.json');

const Finding = z.object({
  kind: z.enum(['hook', 'config', 'git', 'command', 'agent']),
  detail: z.string().max(4096),
  at: z.string().max(64).optional(),
});
const GitStateSchema = z.object({
  config: z.array(z.string()),
  hooks: z.record(z.string(), z.string()),
  redirects: z.array(z.string()),
});
const Saved = z.object({
  workspace: z
    .string()
    .max(1024)
    .refine((p) => path.isAbsolute(p)),
  snapshot: GitStateSchema.extend({
    gitDir: z.boolean(),
    commands: z.record(z.string(), z.string()),
    agent: z.record(z.string(), z.string()).optional(),
    repos: z.record(z.string(), GitStateSchema).optional(),
  }),
});

/**
 * Every project the sandbox can write, and the project roots (whole folders of projects) it has mapped. Older
 * versions saved a single object.
 */
type SavedT = z.output<typeof Saved>;
const Store = z.strictObject({
  projects: z.array(Saved).max(4096),
  roots: z
    .array(
      z
        .string()
        .max(1024)
        .refine((p) => path.isAbsolute(p)),
    )
    .max(64),
});
const StoreAny = z.union([Store, Saved.transform((s) => ({ projects: [s], roots: [] as string[] }))]);
const readStore = (dataPath: string): z.output<typeof Store> =>
  readValid(StoreAny, snapshotFile(dataPath)) ?? { projects: [], roots: [] };
const EMPTY: RepoSnapshot = { gitDir: false, config: [], hooks: {}, redirects: [], commands: {}, agent: {}, repos: {} };
const MAX_ROOT_PROJECTS = 2000;

/** The folders directly inside a project root (plain folders only; links are never followed). */
const rootProjects = (root: string): string[] => {
  if (!dirExists(root) || isLink(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .slice(0, MAX_ROOT_PROJECTS)
    .map((e) => path.join(root, e.name));
};
const has = (projects: SavedT[], workspace: string): boolean =>
  projects.some((s) => s.workspace.toLowerCase() === workspace.toLowerCase());

/**
 * At launch: every folder the sandbox will be able to write. The launch folder, projects mapped with it and every
 * project already inside a project root are snapshotted as they are now, before the sandbox can touch them.
 */
export const saveRepoSnapshot = (
  dataPath: string,
  workspace: string,
  more: string[] = [],
  roots: string[] = [],
): void => {
  const folders = _.uniqBy([workspace, ...more, ...roots.flatMap((r) => [r, ...rootProjects(r)])], (w) =>
    w.toLowerCase(),
  );
  writeJsonAtomic(snapshotFile(dataPath), {
    projects: folders.map((w) => ({ workspace: w, snapshot: snapshotRepo(w) })),
    roots,
  });
};

/**
 * A project that joins the running sandbox: snapshotted before its first session, then guarded like the launch
 * folder. A project already guarded keeps its first snapshot (what was there before the sandbox could touch it).
 */
export const addRepoSnapshot = (dataPath: string, workspace: string, o: { empty?: boolean } = {}): void => {
  const store = readStore(dataPath);
  // A folder inside one that is guarded already is covered by it only for its root files; it gets its own entry.
  if (has(store.projects, workspace)) return;
  writeJsonAtomic(snapshotFile(dataPath), {
    ...store,
    projects: [...store.projects, { workspace, snapshot: o.empty ? EMPTY : snapshotRepo(workspace) }],
  });
};

/**
 * Folders that appeared inside a project root after the launch: the sandbox could have written them from the start,
 * so they get an EMPTY baseline: any git hook, git config that runs programs (core.hooksPath, core.fsmonitor, ...)
 * or planted command in them counts as added inside the sandbox and is neutralised.
 */
const discoverRootProjects = (dataPath: string): SavedT[] => {
  const store = readStore(dataPath);
  const found = store.roots
    .flatMap(rootProjects)
    .filter((w) => !has(store.projects, w))
    .map((workspace) => ({ workspace, snapshot: EMPTY }));
  if (!found.length) return store.projects;
  const projects = [...store.projects, ...found].slice(0, 4096);
  writeJsonAtomic(snapshotFile(dataPath), { ...store, projects });
  return projects;
};

/** The folders being guarded (for status). */
export const guardedProjects = (dataPath: string): string[] => readStore(dataPath).projects.map((s) => s.workspace);

/** Re-checks every project of the current/last launch; findings are kept in a host-only file for `status`. Returns the new ones. */
export const checkRepo = (dataPath: string): RepoFinding[] => {
  const saved = discoverRootProjects(dataPath);
  if (!saved.length) return [];
  const old = repoFindings(dataPath);
  // A finding that cannot be fixed (a file locked in the sandbox) is reported once, not every minute.
  const findings = saved
    .flatMap((s) =>
      guardRepo(s.workspace, s.snapshot).map((f) =>
        saved.length > 1 ? { ...f, detail: s.workspace + ': ' + f.detail } : f,
      ),
    )
    .filter((f) => !old.some((o) => o.kind === f.kind && o.detail === f.detail));
  if (findings.length)
    writeJsonAtomic(findingsFile(dataPath), [...old, ...findings.map((f) => ({ ...f, at: new Date().toISOString() }))]);
  return findings;
};

export const repoFindings = (dataPath: string): (RepoFinding & { at?: string })[] =>
  readValid(z.array(Finding).max(10000), findingsFile(dataPath)) ?? [];
