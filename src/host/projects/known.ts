import path from 'node:path';
import { z } from 'zod';
import { dirExists } from '../../core/util/index.js';
import { JsonFile } from '../../shared/io/index.js';
import { isWithin } from '../../shared/paths/index.js';
import { AbsolutePath } from './registry.js';

const KnownSchema = z.strictObject({
  projects: z.array(z.strictObject({ host: AbsolutePath, lastUsed: z.string().max(64) })).max(2000),
});
type Known = z.output<typeof KnownSchema>;
export type KnownProject = Known['projects'][number];

/** known-projects.json under the storage folder: every folder a project was started in. */
export class KnownProjects {
  private readonly file: JsonFile<Known>;

  constructor(storageRoot: string) {
    this.file = new JsonFile(KnownSchema, path.join(storageRoot, 'known-projects.json'));
  }

  list(): KnownProject[] {
    return this.file.read()?.projects ?? [];
  }

  remember(hostDir: string): void {
    const host = path.resolve(hostDir);
    const rest = this.list().filter((p) => p.host.toLowerCase() !== host.toLowerCase());
    try {
      this.file.write({ projects: [{ host, lastUsed: new Date().toISOString() }, ...rest].slice(0, 2000) });
    } catch {
      /* a convenience list */
    }
  }

  forget(hostDir: string): boolean {
    const host = path.resolve(hostDir);
    const all = this.list();
    const rest = all.filter((p) => p.host.toLowerCase() !== host.toLowerCase());
    if (rest.length !== all.length) this.file.write({ projects: rest });
    return rest.length !== all.length;
  }
}

/**
 * projects.all: the known projects mapped at boot on their own (existing folders, not excluded, not the launch folder,
 * not inside it or a root, which already show them). Pure apart from checking that the folders exist.
 */
export const allProjectsToMap = (
  known: string[],
  o: { primary: string; roots: string[]; exclude: string[]; exists?: (p: string) => boolean },
): string[] => {
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
