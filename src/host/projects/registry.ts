// The projects of the running sandbox, and how another folder joins it (shared/projects.ts explains the ways in).
// Two host-only files under the storage folder, never in the data folder the sandbox can write:
//  - run\projects.json: the running sandbox's projects, roots and machine-wide protections (written at launch, then
//    as folders join);
//  - known-projects.json: every folder this tool has started a project in (for projects.all and `sandbox projects`).
// Everything about HOW a folder becomes visible is behind ProjectMapper, so the mechanisms can change independently.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { IdSchema } from '../../shared/channel/index.js';
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

export const AbsolutePathSchema = z
  .string()
  .max(1024)
  .refine((p) => path.isAbsolute(p), 'must be an absolute path');
const RegistryEntrySchema = z.strictObject({
  name: IdSchema,
  host: AbsolutePathSchema,
  guest: z.string().max(1024),
  primary: z.boolean(),
  mechanism: z.enum(['launch', 'root', 'boot', 'wsb']),
  registeredAt: z.string().max(64),
});
const RegistrySchema = z.strictObject({
  launchId: z.string().max(64),
  /** The running sandbox's protections (core/project-policy.ts), fixed at boot. */
  protections: z.record(z.string(), z.union([z.boolean(), z.string()])),
  roots: z.array(z.strictObject({ host: AbsolutePathSchema, guest: z.string().max(1024) })).max(64),
  projects: z.array(RegistryEntrySchema).max(1024),
  /** What the sandbox booted with that a joining project may also want (missing in registries of 1.4.0 and older). */
  atBoot: z
    .strictObject({
      memoryMb: z.number().int().positive().nullable(),
      mappings: z
        .array(z.strictObject({ host: z.string().max(1024), guest: z.string().max(1024), readOnly: z.boolean() }))
        .max(1024),
      /** Boot settings turned on for a project mapped at boot (setting -> project): other projects share them. */
      widened: z.record(z.string().max(100), z.string().max(100)),
    })
    .optional(),
});
export type AtBoot = NonNullable<z.output<typeof RegistrySchema>['atBoot']>;
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
    atBoot?: AtBoot;
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
      ...(o.atBoot ? { atBoot: o.atBoot } : {}),
    });
    return primary;
  }

  /**
   * What the running sandbox booted with. A sandbox started by 1.4.0 or older has no record: it is read from the .wsb
   * in its launch folder (host-only storage) and recorded. null when neither is there.
   */
  bootRecord(launchPath: string | null): AtBoot | null {
    const registry = this.read();
    if (!registry) return null;
    if (registry.atBoot) return registry.atBoot;
    if (!launchPath) return null;
    let xml: string;
    try {
      xml = fs.readFileSync(path.join(launchPath, 'agent.wsb'), 'utf8');
    } catch {
      return null;
    }
    const atBoot = parseWsbBoot(xml);
    try {
      this.save({ ...registry, atBoot });
    } catch {
      /* the record is a convenience */
    }
    return atBoot;
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

/** Reads the memory and mapped folders back from a .wsb this tool wrote (host-only launch folder; bounded). */
export function parseWsbBoot(xml: string): AtBoot {
  const text = xml.slice(0, 1_000_000);
  const unescape = (s: string): string =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  const mappings = [
    ...text.matchAll(
      /<MappedFolder><HostFolder>([^<]{1,1024})<\/HostFolder><SandboxFolder>([^<]{1,1024})<\/SandboxFolder><ReadOnly>(true|false)<\/ReadOnly><\/MappedFolder>/g,
    ),
  ]
    .slice(0, 1024)
    .map((m) => ({ host: unescape(m[1]), guest: unescape(m[2]), readOnly: m[3] === 'true' }));
  const memory = /<MemoryInMB>(\d{1,7})<\/MemoryInMB>/.exec(text);
  return { memoryMb: memory ? Number(memory[1]) : null, mappings, widened: {} };
}
