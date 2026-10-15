// Which provider the settings ask for. Only `folder` exists so far; contained storage is refused with the way back.
import type { Config } from '../../../core/types.js';
import { fail } from '../../../core/util/index.js';
import { FolderStorageProvider } from './folder.js';
import type { StorageProvider } from './types.js';

export function providerFor(config: Config): StorageProvider {
  if (config.storage.contained !== 'off')
    fail(
      'Contained storage is not available yet (beta, coming in 1.9).',
      'Set storage.contained to "off" (the default) in your settings.',
    );
  return new FolderStorageProvider();
}
