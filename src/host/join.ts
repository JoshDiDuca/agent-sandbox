// Joining the running sandbox from another folder. The folder's run is resolved exactly as a fresh launch would
// resolve it (its approved .sandbox-config.json, versions, toolchain detection, database plan), checked against the
// running sandbox's machine-wide protections, made visible inside (host/projects.ts: a project root, a project
// mapped at boot, or wsb share) and described to the guest, which provisions what is missing before its session.
// When none of those can make it visible, NeedsRestart reaches the caller, which offers a restart. So does a project
// that wants what the sandbox only gets at its start (a .wsb device, more memory, its mappings) when you choose to
// restart for it; otherwise it joins without them and they are named.
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedRun } from '../core/types.js';
import { checkJoin, missingAtBoot, nothingMissing, protectionsOf, type Missing } from '../core/project-policy.js';
import { resolveToolchains } from '../core/detect-toolchains.js';
import { assertNoLinks, dirExists, fail } from '../core/util.js';
import { Id, type ProjectSpecT } from '../shared/schema.js';
import { readSandboxStatus } from '../shared/rundir.js';
import { syncProjectIn } from '../sync/watcher.js';
import { planDatabases } from './database-plan.js';
import { decideProjectToolchains } from './generate.js';
import { bootRecordOf, NeedsRestart, projectHere, projectMapper, readRegistry, rememberProject, rootHere, type ProjectMapper, type RegistryEntry } from './projects.js';
import { stageScripts } from './launch/stage.js';
import { addRepoSnapshot } from './repo-guard.js';

/** The launch folder of the running sandbox (host-only storage; its id comes from the guest, so it is checked). */
export const runningLaunchPath = (storageRoot: string, dataPath: string): string | null => {
  const launchId = readSandboxStatus(dataPath)?.launchId;
  if (!launchId || !/^\d+-[0-9a-f]{6}$/.test(launchId) || readRegistry(storageRoot)?.launchId !== launchId) return null;
  const launchPath = path.join(storageRoot, 'launches', launchId);
  assertNoLinks(storageRoot, launchPath);
  return fs.existsSync(path.join(launchPath, 'session.json')) ? launchPath : null;
};

/** What a session or command from this folder needs: where it is inside, and (for another project) its spec. */
export interface Joined {
  project: RegistryEntry; guestDir: string; spec: ProjectSpecT | null; run: ResolvedRun | null; notes: string[];
  /** What it wants at boot that the running sandbox started without (it joined without them). */
  missing: Missing | null;
}

/** What to do when a joining project wants something the running sandbox started without. */
export type MissingChoice = 'continue' | 'restart' | 'cancel';

/** The project spec the guest provisions from (scans the project folder like a launch does). */
export const projectSpec = (run: ResolvedRun, entry: RegistryEntry, hooks: boolean): ProjectSpecT => {
  const { config } = run;
  const toolchains = resolveToolchains(config.toolchains, decideProjectToolchains({ run }));
  const harness = run.harnessName === 'none' ? null : config.harnesses[run.harnessName];
  return {
    name: Id.parse(entry.name), workspace: entry.guest, workspaceHost: entry.host, toolchains, versions: run.versions,
    databases: planDatabases(config.databases, run.workspaceHost).slice(0, 8),
    harnesses: harness ? { [run.harnessName]: harness } : {},
    hooks,
  };
};

/**
 * Makes `hostDir` usable in the running sandbox. The launch folder (or a folder below it) needs nothing; any other
 * folder is resolved with `resolve` (the caller's resolveRun, with the approval prompt), checked, and registered.
 */
export const joinRunning = async (o: {
  storageRoot: string; dataPath: string; packageRoot: string; hostDir: string; wsbShare: boolean;
  resolve: (projectRoot: string) => Promise<ResolvedRun>; mapper?: ProjectMapper;
  /** Asked before anything is registered when something is missing (default: continue without it). */
  decide?: (name: string, missing: Missing) => Promise<MissingChoice>;
}): Promise<Joined> => {
  const here = projectHere(o.storageRoot, o.hostDir);
  if (here?.project.primary) return { ...here, spec: null, run: null, notes: [], missing: null };
  const registry = readRegistry(o.storageRoot) ?? fail('The running sandbox was started by an older version, so it cannot take another folder.', 'Stop it (sandbox stop) and start it again.');
  // A folder below a project already in the sandbox uses that project; anything else becomes a project of its own.
  const root = here?.project.host ?? path.resolve(o.hostDir);
  const run = await o.resolve(root);
  const check = checkJoin(registry.protections, protectionsOf(run.config), Object.keys(registry.atBoot?.widened ?? {}));
  if (check.stricter.length) {
    fail('This project needs stricter protection than the running sandbox has, and those settings are machine-wide:\n  ' + check.stricter.join('\n  '),
      'Its sessions cannot get them without changing them for the sessions already running. Stop the sandbox (sandbox stop) and start it from ' + root + '.');
  }
  // Boot-only wishes (a .wsb device you allowed for it, more memory, its mappings) the running sandbox lacks.
  const launchPath = runningLaunchPath(o.storageRoot, o.dataPath);
  const boot = bootRecordOf(o.storageRoot, launchPath);
  const found = boot ? missingAtBoot(registry.protections, boot, run.config, dirExists) : null;
  const missing = found && !nothingMissing(found) ? found : null;
  if (missing) {
    const choice = o.decide ? await o.decide(here?.project.name ?? path.basename(root), missing) : 'continue';
    if (choice === 'cancel') fail('Cancelled: nothing changed.');
    if (choice === 'restart') throw new NeedsRestart(root, 'it wants what the sandbox only gets at its start', missing);
  }
  const mapper = o.mapper ?? projectMapper({ storageRoot: o.storageRoot, packageRoot: o.packageRoot, wsbShare: o.wsbShare });
  // Guarded from now on. A folder the sandbox could already write (inside a root, or mapped at boot) and that has no
  // snapshot from the launch gets an empty one: what is there now may have been planted, so it counts as new.
  // Anything else is snapshotted before it becomes visible.
  addRepoSnapshot(o.dataPath, root, { empty: Boolean(here) || Boolean(rootHere(o.storageRoot, root)) });
  const entry = mapper.register(root);
  rememberProject(o.storageRoot, entry.host);
  // Your hooks in ~/.agent-sandbox/hooks ran at boot (once per sandbox); the project's own scripts ("scripts" in its
  // .sandbox-config.json, --script) run before its first agent. The launch folder is read-only for the sandbox, but
  // this side can still add them to it.
  const hooks = Boolean(launchPath) && run.scripts.length > 0;
  if (launchPath && hooks) stageScripts(path.join(launchPath, 'projects', entry.name, 'hooks', 'pre-agent'), run.scripts);
  try { syncProjectIn(o.dataPath, { hostWorkspace: entry.host, guestWorkspace: entry.guest }); } catch { /* history is a convenience; never block the session */ }
  const notes = [...run.notes, ...check.looser.map((l) => 'The running sandbox is stricter: ' + l + '.'),
    ...check.shared.map((s) => s + ' is on in this sandbox for another of its projects (you allowed it there); this project shares it.')];
  return { project: entry, guestDir: here ? here.guestDir : entry.guest, spec: projectSpec(run, entry, hooks), run, notes, missing };
};
