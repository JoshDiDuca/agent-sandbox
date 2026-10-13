import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import { dirExists, isLink } from '../../core/util/index.js';
import { RepoGuard, type RepoFinding, type RepoSnapshot } from './repo-guard.js';

// ---- snapshot storage (host-only, next to the sync state) ---------------------------------------------------------

const syncDir = (dataPath: string): string => path.join(path.dirname(path.dirname(dataPath)), 'sync');
const snapshotFile = (dataPath: string): string => path.join(syncDir(dataPath), path.basename(dataPath) + '-repo.json');
const findingsFile = (dataPath: string): string =>
  path.join(syncDir(dataPath), path.basename(dataPath) + '-repo-findings.json');

const FindingSchema = z.object({
  kind: z.enum(['hook', 'config', 'git', 'command', 'agent']),
  detail: z.string().max(4096),
  at: z.string().max(64).optional(),
});
const GitStateSchema = z.object({
  config: z.array(z.string()),
  hooks: z.record(z.string(), z.string()),
  redirects: z.array(z.string()),
});
const SavedSchema = z.object({
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
type Saved = z.output<typeof SavedSchema>;
const StoreSchema = z.strictObject({
  projects: z.array(SavedSchema).max(4096),
  roots: z
    .array(
      z
        .string()
        .max(1024)
        .refine((p) => path.isAbsolute(p)),
    )
    .max(64),
});
type Store = z.output<typeof StoreSchema>;
/** A recorded finding (`at`: when it was found). */
export type RecordedFinding = RepoFinding & { at?: string };
const StoreAny = z.union([StoreSchema, SavedSchema.transform((s) => ({ projects: [s], roots: [] as string[] }))]);
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
const has = (projects: Saved[], workspace: string): boolean =>
  projects.some((s) => s.workspace.toLowerCase() === workspace.toLowerCase());

/** The guarded projects of one data folder and what the guard found (host-only files next to the sync state). */
export class RepoGuardStore {
  private readonly snapshots: JsonFile<Store>;
  private readonly found: JsonFile<RecordedFinding[]>;

  constructor(
    dataPath: string,
    private readonly guard = new RepoGuard(),
  ) {
    this.snapshots = new JsonFile(StoreAny, snapshotFile(dataPath));
    this.found = new JsonFile(z.array(FindingSchema).max(10000), findingsFile(dataPath));
  }

  private read(): Store {
    return this.snapshots.read() ?? { projects: [], roots: [] };
  }

  /**
   * At launch: every folder the sandbox will be able to write. The launch folder, projects mapped with it and every
   * project already inside a project root are snapshotted as they are now, before the sandbox can touch them.
   */
  save(workspace: string, more: string[] = [], roots: string[] = []): void {
    const folders = _.uniqBy([workspace, ...more, ...roots.flatMap((r) => [r, ...rootProjects(r)])], (w) =>
      w.toLowerCase(),
    );
    this.snapshots.write({
      projects: folders.map((w) => ({ workspace: w, snapshot: this.guard.snapshot(w) })),
      roots,
    });
  }

  /**
   * A project that joins the running sandbox: snapshotted before its first session, then guarded like the launch
   * folder. A project already guarded keeps its first snapshot (what was there before the sandbox could touch it).
   */
  add(workspace: string, o: { empty?: boolean } = {}): void {
    const store = this.read();
    // A folder inside one that is guarded already is covered by it only for its root files; it gets its own entry.
    if (has(store.projects, workspace)) return;
    this.snapshots.write({
      ...store,
      projects: [...store.projects, { workspace, snapshot: o.empty ? EMPTY : this.guard.snapshot(workspace) }],
    });
  }

  /**
   * Folders that appeared inside a project root after the launch: the sandbox could have written them from the start,
   * so they get an EMPTY baseline: any git hook, git config that runs programs (core.hooksPath, core.fsmonitor, ...)
   * or planted command in them counts as added inside the sandbox and is neutralised.
   */
  private discoverRootProjects(): Saved[] {
    const store = this.read();
    const found = store.roots
      .flatMap(rootProjects)
      .filter((w) => !has(store.projects, w))
      .map((workspace) => ({ workspace, snapshot: EMPTY }));
    if (!found.length) return store.projects;
    const projects = [...store.projects, ...found].slice(0, 4096);
    this.snapshots.write({ ...store, projects });
    return projects;
  }

  /** The folders being guarded (for status). */
  guarded(): string[] {
    return this.read().projects.map((s) => s.workspace);
  }

  /** Re-checks every project of the current/last launch; findings are kept in a host-only file for `status`. Returns the new ones. */
  check(): RepoFinding[] {
    const saved = this.discoverRootProjects();
    if (!saved.length) return [];
    const old = this.findings();
    // A finding that cannot be fixed (a file locked in the sandbox) is reported once, not every minute.
    const findings = saved
      .flatMap((s) =>
        this.guard
          .guard(s.workspace, s.snapshot)
          .map((f) => (saved.length > 1 ? { ...f, detail: s.workspace + ': ' + f.detail } : f)),
      )
      .filter((f) => !old.some((o) => o.kind === f.kind && o.detail === f.detail));
    if (findings.length) this.found.write([...old, ...findings.map((f) => ({ ...f, at: new Date().toISOString() }))]);
    return findings;
  }

  findings(): RecordedFinding[] {
    return this.found.read() ?? [];
  }
}
