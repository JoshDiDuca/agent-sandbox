// Contained storage for the Windows Sandbox engine (beta, untested on a real PC): the data set splits. `run\` stays
// the plain data folder shared in as before; tools, state, logs, databases and cache live in a disk image that is
// mounted at <storage>\mounts\<set> (no drive letter) and shared in from there, to the same guest paths.
import fs from 'node:fs';
import path from 'node:path';
import { containedAvailability } from '../contained/check.js';
import { ContainedStorage, type ContainedDeps, type HolderId } from '../contained/contained-storage.js';
import { containedMappings, setNameOf } from '../contained/layout.js';
import type { DataSet, PreparedStorage, ProviderCheck, StorageProvider } from './types.js';

export class ContainedStorageProvider implements StorageProvider {
  readonly id = 'vhdx-mounted';
  private storage: ContainedStorage | null = null;

  constructor(
    private readonly deps: ContainedDeps,
    private readonly holder: HolderId = { id: 'launch', pid: process.pid },
    private readonly availability: () => ProviderCheck = containedAvailability,
  ) {}

  check(): Promise<ProviderCheck> {
    return Promise.resolve(this.availability());
  }

  /** Mounts the image (the one Windows permission prompt of a launch, when it is not mounted yet). */
  async prepare(dataSet: DataSet): Promise<PreparedStorage> {
    const storage = new ContainedStorage(this.deps, setNameOf(dataSet.dataPath));
    this.storage = storage;
    const mount = await storage.acquire(this.holder);
    fs.mkdirSync(path.join(dataSet.dataPath, 'run'), { recursive: true });
    const mappings = containedMappings(dataSet.dataPath, mount, dataSet.guest);
    return {
      attachments: mappings.map((m) => ({ kind: 'folder', host: m.host, guest: m.guest, readOnly: m.readOnly })),
      mappings,
    };
  }

  /** Lets go of the mount (a launch that stopped before the sandbox started). The watcher holds it afterwards. */
  async release(): Promise<void> {
    await this.storage?.release(this.holder.id);
  }
}
