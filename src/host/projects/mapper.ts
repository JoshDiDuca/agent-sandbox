import path from 'node:path';
import { assertSafeWorkspace } from '../../core/safe-paths.js';
import { dirExists, fail } from '../../core/util/index.js';
import { guestDirFor, hubName, PROJECTS_GUEST, projectForHostDir, type Mechanism } from '../../shared/paths/index.js';
import { detectWsb, runningSandboxId, shareFolder, type Wsb } from '../sandbox/index.js';
import { type RegistryEntry, type ProjectRegistry, readRegistry, saveRegistry } from './registry.js';

/** Why a folder cannot join the running sandbox without a restart (the caller offers one). */
export class NeedsRestart extends Error {
  constructor(
    public readonly hostDir: string,
    public readonly reason: string,
  ) {
    super(reason);
  }
}

export interface ProjectMapper {
  /** The projects of the running sandbox (the launch folder first). */
  list(): RegistryEntry[];
  /** Makes a folder of this PC a project of the running sandbox; throws NeedsRestart when that needs a restart. */
  register(hostDir: string): RegistryEntry;
  /** Forgets a project (never the launch folder). Its folder stays visible until the next start if it is mapped. */
  unregister(name: string): void;
}

export interface MapperOptions {
  storageRoot: string;
  packageRoot: string;
  wsbShare: boolean;
  detect?: () => Wsb | null;
}

/** Roots first (instant), then `wsb share` where the Windows Sandbox CLI exists, else NeedsRestart. */
export const projectMapper = (o: MapperOptions): ProjectMapper => {
  const registry = (): ProjectRegistry =>
    readRegistry(o.storageRoot) ??
    fail(
      'The running sandbox was started by an older version, so it cannot take another folder.',
      'Stop it (sandbox stop) and start it again.',
    );
  const add = (
    reg: ProjectRegistry,
    host: string,
    guest: string,
    mechanism: Mechanism,
    name: string,
  ): RegistryEntry => {
    const entry: RegistryEntry = {
      name,
      host,
      guest,
      primary: false,
      mechanism,
      registeredAt: new Date().toISOString(),
    };
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
      const name = hubName(
        host,
        reg.projects.map((p) => p.name),
      );
      // Inside a root: visible already (also a project created after the sandbox started).
      const root = projectForHostDir(reg.roots, host);
      if (root) return add(reg, host, guestDirFor(root, host), 'root', name);
      if (!o.wsbShare)
        throw new NeedsRestart(
          host,
          'it is not inside a project root (projects.roots), and adding folders with wsb share is off (projects.wsbShare)',
        );
      const wsb = (o.detect ?? detectWsb)();
      if (!wsb?.has('share'))
        throw new NeedsRestart(
          host,
          'it is not inside a project root (projects.roots), and this Windows has no Windows Sandbox command line (wsb share needs Windows 11 24H2+ with the updated Windows Sandbox)',
        );
      const sandbox = runningSandboxId(wsb);
      if (!sandbox.id) throw new NeedsRestart(host, 'wsb share could not find the running sandbox: ' + sandbox.error);
      const guest = path.win32.join(PROJECTS_GUEST, name);
      const shared = shareFolder(wsb, sandbox.id, host, guest);
      if (!shared.ok) throw new NeedsRestart(host, 'wsb share failed (untested on this Windows): ' + shared.error);
      return add(reg, host, guest, 'wsb', name);
    },
    unregister: (name) => {
      const reg = registry();
      const entry = reg.projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (!entry) fail('No project "' + name + '" in the running sandbox.', 'sandbox projects lists them.');
      if (entry.primary)
        fail(entry.host + ' is the folder the sandbox started from; it stays until the sandbox stops.');
      saveRegistry(o.storageRoot, { ...reg, projects: reg.projects.filter((p) => p !== entry) });
    },
  };
};
