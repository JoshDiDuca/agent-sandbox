// The projects of the running sandbox, and how another folder joins it (shared/projects.ts explains the ways in).
// Two host-only files under the storage folder, never in the data folder the sandbox can write:
//  - run\projects.json: the running sandbox's projects, roots and machine-wide protections (written at launch, then
//    as folders join);
//  - known-projects.json: every folder this tool has started a project in (for projects.all and `sandbox projects`).
// Everything about HOW a folder becomes visible is behind ProjectMapper, so the mechanisms can change independently.
import path from 'node:path';
import { z } from 'zod';
import { Id } from '../../shared/channel/index.js';
import { JsonFile } from '../../shared/io/index.js';
import {
  guestDirFor,
  hubName,
  PROJECTS_GUEST,
  projectForHostDir,
  type ProjectEntry,
  type RootMapping,
} from '../../shared/paths/index.js';

export { PROJECTS_GUEST };
export type { ProjectEntry };

export const AbsolutePath = z
  .string()
  .max(1024)
  .refine((p) => path.isAbsolute(p), 'must be an absolute path');
const RegistryEntrySchema = z.strictObject({
  name: Id,
  host: AbsolutePath,
  guest: z.string().max(1024),
  primary: z.boolean(),
  mechanism: z.enum(['launch', 'root', 'boot', 'wsb']),
  registeredAt: z.string().max(64),
});
const RegistrySchema = z.strictObject({
  launchId: z.string().max(64),
  /** The running sandbox's protections (core/project-policy.ts), fixed at boot. */
  protections: z.record(z.string(), z.union([z.boolean(), z.string()])),
  roots: z.array(z.strictObject({ host: AbsolutePath, guest: z.string().max(1024) })).max(64),
  projects: z.array(RegistryEntrySchema).max(1024),
});
export type RegistryEntry = z.output<typeof RegistryEntrySchema>;
export type Registry = z.output<typeof RegistrySchema>;

/** Which project of the running sandbox a folder on this PC is in, and where that folder is inside. */
export interface ProjectHere {
  project: RegistryEntry;
  guestDir: string;
}

/** run\projects.json under the storage folder: the running sandbox's projects and roots. */
export class ProjectRegistry {
  private readonly file: JsonFile<Registry>;

  constructor(storageRoot: string) {
    this.file = new JsonFile(RegistrySchema, path.join(storageRoot, 'run', 'projects.json'));
  }

  read(): Registry | null {
    return this.file.read();
  }

  save(registry: Registry): void {
    this.file.write(registry);
  }

  /** At launch: the launch folder, the projects mapped with it, and the roots. */
  start(o: {
    launchId: string;
    protections: Registry['protections'];
    primary: RootMapping;
    roots: RootMapping[];
    boot: RootMapping[];
  }): RegistryEntry {
    const at = new Date().toISOString();
    const primary: RegistryEntry = {
      name: hubName(o.primary.host, []),
      host: o.primary.host,
      guest: o.primary.guest,
      primary: true,
      mechanism: 'launch',
      registeredAt: at,
    };
    const names = [primary.name];
    const boot = o.boot.map((b): RegistryEntry => {
      const name = hubName(b.host, names);
      names.push(name);
      return { name, host: b.host, guest: b.guest, primary: false, mechanism: 'boot', registeredAt: at };
    });
    this.save({
      launchId: o.launchId,
      protections: o.protections,
      roots: o.roots,
      projects: [primary, ...boot],
    });
    return primary;
  }

  /** Which project of the running sandbox this folder is in, and where it is inside. */
  here(hostDir: string): ProjectHere | null {
    const project = projectForHostDir(this.read()?.projects ?? [], hostDir);
    return project ? { project, guestDir: guestDirFor(project, hostDir) } : null;
  }

  /** The running sandbox's root containing this folder, if any. */
  rootHere(hostDir: string): RootMapping | null {
    return projectForHostDir(this.read()?.roots ?? [], hostDir);
  }
}
