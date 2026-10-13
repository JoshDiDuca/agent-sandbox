import path from 'node:path';
import { assertSafeWorkspace } from '../../core/safe-paths.js';
import { dirExists, fail } from '../../core/util/index.js';
import type { Missing } from '../../core/local-config/index.js';
import { guestDirFor, hubName, ownGuestFolder, projectForHostDir, type Mechanism } from '../../shared/paths/index.js';
import { detectWsb, runningSandboxId, shareFolder, type Wsb } from '../sandbox/index.js';
import { ProjectRegistry, type Registry, type RegistryEntry } from './registry.js';

/**
 * Why a folder cannot join the running sandbox without a restart (the caller offers one). With `missing`: it could
 * join, but you chose to restart for what it wants at boot (core/local-config/boot-wants.ts).
 */
export class NeedsRestart extends Error {
  constructor(
    public readonly hostDir: string,
    public readonly reason: string,
    public readonly missing?: Missing,
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
  const store = new ProjectRegistry(o.storageRoot);
  const registry = (): Registry =>
    store.read() ??
    fail(
      'The running sandbox was started by an older version, so it cannot take another folder.',
      'Stop it (sandbox stop) and start it again.',
    );
  const add = (reg: Registry, host: string, guest: string, mechanism: Mechanism, name: string): RegistryEntry => {
    const entry: RegistryEntry = {
      name,
      host,
      guest,
      primary: false,
      mechanism,
      registeredAt: new Date().toISOString(),
    };
    // Re-read right before writing: another terminal may have registered something meanwhile.
    const latest = store.read() ?? reg;
    const same = latest.projects.find((p) => p.host.toLowerCase() === host.toLowerCase());
    if (same) return same;
    store.save({ ...latest, projects: [...latest.projects, entry] });
    return entry;
  };
  return {
    list: () => store.read()?.projects ?? [],
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
      // Where it is as a launch folder too (C:\Workspace\<name>), unless another project already uses that place.
      const guest = ownGuestFolder(host, false, [
        ...reg.projects.map((p) => p.guest),
        ...reg.roots.map((r) => r.guest),
      ]);
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
      store.save({ ...reg, projects: reg.projects.filter((p) => p !== entry) });
    },
  };
};
