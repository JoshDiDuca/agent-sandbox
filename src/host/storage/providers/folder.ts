// The storage kind used today: the data folder on this PC is shared into the sandbox as it is.
import type { ResolvedMapping } from '../../../core/types.js';
import type { DataSet, PreparedStorage, ProviderCheck, StorageAttachment, StorageProvider } from './types.js';

/** The data folder as a read/write attachment. */
export function folderAttachment(dataSet: DataSet): StorageAttachment {
  return { kind: 'folder', host: dataSet.dataPath, guest: dataSet.guest, readOnly: false };
}

/** The data folder as a mapping (the launch builds its mapping list synchronously, so this is the plain function). */
export function dataMapping(dataSet: DataSet): ResolvedMapping {
  return { host: dataSet.dataPath, guest: dataSet.guest, readOnly: false };
}

export class FolderStorageProvider implements StorageProvider {
  readonly id = 'folder';

  check(): Promise<ProviderCheck> {
    return Promise.resolve({ available: true, reasons: [], fixes: [] });
  }

  prepare(dataSet: DataSet): Promise<PreparedStorage> {
    return Promise.resolve({ attachments: [folderAttachment(dataSet)], mappings: [dataMapping(dataSet)] });
  }

  release(): Promise<void> {
    return Promise.resolve();
  }
}
