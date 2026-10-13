// The projects of the running sandbox, and how another folder joins it (shared/projects.ts explains the ways in).
// Two host-only files under the storage folder, never in the data folder the sandbox can write:
//  - run\projects.json: the running sandbox's projects, roots and machine-wide protections (written at launch, then
//    as folders join);
//  - known-projects.json: every folder this tool has started a project in (for projects.all and `sandbox projects`).
// Everything about HOW a folder becomes visible is behind ProjectMapper, so the mechanisms can change independently.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Missing } from '../core/project-policy.js';
import { assertSafeWorkspace } from '../core/safe-paths.js';
import { dirExists, fail } from '../core/util.js';
import { Id } from '../shared/schema.js';
import { readValid, writeJsonAtomic } from '../shared/rundir.js';
import { guestDirFor, hubName, isWithin, ownGuestFolder, PROJECTS_GUEST, projectForHostDir, type Mechanism, type ProjectEntry, type RootMapping } from '../shared/projects.js';
import { detectWsb, runningSandboxId, shareFolder, type Wsb } from './wsb.js';

export { PROJECTS_GUEST };
export type { ProjectEntry };

const AbsolutePath = z.string().max(1024).refine((p) => path.isAbsolute(p), 'must be an absolute path');
const Entry = z.strictObject({
  name: Id, host: AbsolutePath, guest: z.string().max(1024), primary: z.boolean(),
  mechanism: z.enum(['launch', 'root', 'boot', 'wsb']), registeredAt: z.string().max(64),
});
const Registry = z.strictObject({
  launchId: z.string().max(64),
  /** The running sandbox's protections (core/project-policy.ts), fixed at boot. */
  protections: z.record(z.string(), z.union([z.boolean(), z.string()])),
  roots: z.array(z.strictObject({ host: AbsolutePath, guest: z.string().max(1024) })).max(64),
  projects: z.array(Entry).max(1024),
  /** What the sandbox booted with that a joining project may also want (missing in registries of 1.4.0 and older). */
  atBoot: z.strictObject({
    memoryMb: z.number().int().positive().nullable(),
    mappings: z.array(z.strictObject({ host: z.string().max(1024), guest: z.string().max(1024), readOnly: z.boolean() })).max(1024),
    /** Boot settings turned on for a project mapped at boot (setting -> project): other projects share them. */
    widened: z.record(z.string().max(100), z.string().max(100)),
  }).optional(),
});
export type AtBoot = NonNullable<z.output<typeof Registry>['atBoot']>;
export type RegistryEntry = z.output<typeof Entry>;
export type ProjectRegistry = z.output<typeof Registry>;

const registryFile = (storageRoot: string): string => path.join(storageRoot, 'run', 'projects.json');
export const readRegistry = (storageRoot: string): ProjectRegistry | null => readValid(Registry, registryFile(storageRoot));
const saveRegistry = (storageRoot: string, registry: ProjectRegistry): void => writeJsonAtomic(registryFile(storageRoot), registry);

/** At launch: the launch folder, the projects mapped with it, and the roots. */
export const startRegistry = (storageRoot: string, o: { launchId: string; protections: ProjectRegistry['protections']; primary: RootMapping; roots: RootMapping[]; boot: RootMapping[]; atBoot?: AtBoot }): RegistryEntry => {
  const at = new Date().toISOString();
  const primary: RegistryEntry = { name: hubName(o.primary.host, []), host: o.primary.host, guest: o.primary.guest, primary: true, mechanism: 'launch', registeredAt: at };
  const names = [primary.name];
  const boot = o.boot.map((b): RegistryEntry => { const name = hubName(b.host, names); names.push(name); return { name, host: b.host, guest: b.guest, primary: false, mechanism: 'boot', registeredAt: at }; });
  saveRegistry(storageRoot, { launchId: o.launchId, protections: o.protections, roots: o.roots, projects: [primary, ...boot], ...(o.atBoot ? { atBoot: o.atBoot } : {}) });
  return primary;
};

/** Reads the memory and mapped folders back from a .wsb this tool wrote (host-only launch folder; bounded). */
export const parseWsbBoot = (xml: string): AtBoot => {
  const text = xml.slice(0, 1_000_000);
  const unescape = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');
  const mappings = [...text.matchAll(/<MappedFolder><HostFolder>([^<]{1,1024})<\/HostFolder><SandboxFolder>([^<]{1,1024})<\/SandboxFolder><ReadOnly>(true|false)<\/ReadOnly><\/MappedFolder>/g)]
    .slice(0, 1024).map((m) => ({ host: unescape(m[1]), guest: unescape(m[2]), readOnly: m[3] === 'true' }));
  const memory = /<MemoryInMB>(\d{1,7})<\/MemoryInMB>/.exec(text);
  return { memoryMb: memory ? Number(memory[1]) : null, mappings, widened: {} };
};

/**
 * What the running sandbox booted with. A sandbox started by 1.4.0 or older has no record: it is read from the .wsb in
 * its launch folder (host-only storage) and recorded. null when neither is there.
 */
export const bootRecordOf = (storageRoot: string, launchPath: string | null): AtBoot | null => {
  const registry = readRegistry(storageRoot);
  if (!registry) return null;
  if (registry.atBoot) return registry.atBoot;
  if (!launchPath) return null;
  let xml: string;
  try { xml = fs.readFileSync(path.join(launchPath, 'agent.wsb'), 'utf8'); } catch { return null; }
  const atBoot = parseWsbBoot(xml);
  try { saveRegistry(storageRoot, { ...registry, atBoot }); } catch { /* the record is a convenience */ }
  return atBoot;
};

/**
 * Why a folder cannot join the running sandbox without a restart (the caller offers one). With `missing`: it could
 * join, but you chose to restart for what it wants at boot (core/project-policy.ts).
 */
export class NeedsRestart extends Error {
  constructor(public readonly hostDir: string, public readonly reason: string, public readonly missing?: Missing) { super(reason); }
}

export interface ProjectMapper {
  /** The projects of the running sandbox (the launch folder first). */
  list(): RegistryEntry[];
  /** Makes a folder of this PC a project of the running sandbox; throws NeedsRestart when that needs a restart. */
  register(hostDir: string): RegistryEntry;
  /** Forgets a project (never the launch folder). Its folder stays visible until the next start if it is mapped. */
  unregister(name: string): void;
}

export interface MapperOptions { storageRoot: string; packageRoot: string; wsbShare: boolean; detect?: () => Wsb | null }

/** Roots first (instant), then `wsb share` where the Windows Sandbox CLI exists, else NeedsRestart. */
export const projectMapper = (o: MapperOptions): ProjectMapper => {
  const registry = (): ProjectRegistry => readRegistry(o.storageRoot) ?? fail('The running sandbox was started by an older version, so it cannot take another folder.', 'Stop it (sandbox stop) and start it again.');
  const add = (reg: ProjectRegistry, host: string, guest: string, mechanism: Mechanism, name: string): RegistryEntry => {
    const entry: RegistryEntry = { name, host, guest, primary: false, mechanism, registeredAt: new Date().toISOString() };
    // Re-read right before writing: another terminal may have registered something meanwhile.
    const latest = readRegistry(o.storageRoot) ?? reg;
    const same = latest.projects.find((p) => p.host.toLowerCase() === host.toLowerCase());
    if (same) return same;
    saveRegistry(o.storageRoot, { ...latest, projects: [...latest.projects, entry] });
    return entry;
  };
  return {
    list: () => readRegistry(o.storageRoot)?.projects ?? [],
    register: (hostDir) => {
      const host = path.resolve(hostDir);
      const reg = registry();
      const known = reg.projects.find((p) => p.host.toLowerCase() === host.toLowerCase());
      if (known) return known;
      assertSafeWorkspace(host, o.packageRoot, o.storageRoot);
      if (!dirExists(host)) fail('The folder does not exist: ' + host);
      const name = hubName(host, reg.projects.map((p) => p.name));
      // Inside a root: visible already (also a project created after the sandbox started).
      const root = projectForHostDir(reg.roots, host);
      if (root) return add(reg, host, guestDirFor(root, host), 'root', name);
      if (!o.wsbShare) throw new NeedsRestart(host, 'it is not inside a project root (projects.roots), and adding folders with wsb share is off (projects.wsbShare)');
      const wsb = (o.detect ?? detectWsb)();
      if (!wsb?.has('share')) throw new NeedsRestart(host, 'it is not inside a project root (projects.roots), and this Windows has no Windows Sandbox command line (wsb share needs Windows 11 24H2+ with the updated Windows Sandbox)');
      const sandbox = runningSandboxId(wsb);
      if (!sandbox.id) throw new NeedsRestart(host, 'wsb share could not find the running sandbox: ' + sandbox.error);
      // Where it is as a launch folder too (C:\Workspace\<name>), unless another project already uses that place.
      const guest = ownGuestFolder(host, false, [...reg.projects.map((p) => p.guest), ...reg.roots.map((r) => r.guest)]);
      const shared = shareFolder(wsb, sandbox.id, host, guest);
      if (!shared.ok) throw new NeedsRestart(host, 'wsb share failed (untested on this Windows): ' + shared.error);
      return add(reg, host, guest, 'wsb', name);
    },
    unregister: (name) => {
      const reg = registry();
      const entry = reg.projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (!entry) fail('No project "' + name + '" in the running sandbox.', 'sandbox projects lists them.');
      if (entry.primary) fail(entry.host + ' is the folder the sandbox started from; it stays until the sandbox stops.');
      saveRegistry(o.storageRoot, { ...reg, projects: reg.projects.filter((p) => p !== entry) });
    },
  };
};

/** Which project of the running sandbox a folder on this PC is in, and where that folder is inside. */
export interface ProjectHere { project: RegistryEntry; guestDir: string }
export const projectHere = (storageRoot: string, hostDir: string): ProjectHere | null => {
  const project = projectForHostDir(readRegistry(storageRoot)?.projects ?? [], hostDir);
  return project ? { project, guestDir: guestDirFor(project, hostDir) } : null;
};

/** The running sandbox's root containing this folder, if any. */
export const rootHere = (storageRoot: string, hostDir: string): RootMapping | null => projectForHostDir(readRegistry(storageRoot)?.roots ?? [], hostDir);

// ---- known projects (every folder a project was started in) ------------------------------------------------------

const Known = z.strictObject({ projects: z.array(z.strictObject({ host: AbsolutePath, lastUsed: z.string().max(64) })).max(2000) });
export type KnownProject = z.output<typeof Known>['projects'][number];
const knownFile = (storageRoot: string): string => path.join(storageRoot, 'known-projects.json');

export const readKnown = (storageRoot: string): KnownProject[] => readValid(Known, knownFile(storageRoot))?.projects ?? [];

export const rememberProject = (storageRoot: string, hostDir: string): void => {
  const host = path.resolve(hostDir);
  const rest = readKnown(storageRoot).filter((p) => p.host.toLowerCase() !== host.toLowerCase());
  try { writeJsonAtomic(knownFile(storageRoot), { projects: [{ host, lastUsed: new Date().toISOString() }, ...rest].slice(0, 2000) }); } catch { /* a convenience list */ }
};

export const forgetProject = (storageRoot: string, hostDir: string): boolean => {
  const host = path.resolve(hostDir);
  const all = readKnown(storageRoot);
  const rest = all.filter((p) => p.host.toLowerCase() !== host.toLowerCase());
  if (rest.length !== all.length) writeJsonAtomic(knownFile(storageRoot), { projects: rest });
  return rest.length !== all.length;
};

/**
 * projects.all: the known projects mapped at boot on their own (existing folders, not excluded, not the launch folder,
 * not inside it or a root, which already show them). Pure apart from checking that the folders exist.
 */
export const allProjectsToMap = (known: string[], o: { primary: string; roots: string[]; exclude: string[]; exists?: (p: string) => boolean }): string[] => {
  const exists = o.exists ?? dirExists;
  const out: string[] = [];
  for (const host of known.map((k) => path.resolve(k))) {
    if (o.exclude.some((e) => isWithin(path.resolve(e), host))) continue;
    if (isWithin(o.primary, host) || o.roots.some((r) => isWithin(r, host))) continue;
    if (out.some((x) => isWithin(x, host) || isWithin(host, x)) || !exists(host)) continue;
    out.push(host);
  }
  return out;
};
