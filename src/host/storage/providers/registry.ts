// Which provider the settings ask for. `folder` is today's; `vhdx` is contained storage (beta), which needs the
// storage folder and the ways to reach the disk (ContainedDeps) and is refused with the reasons when this PC cannot
// use it.
import type { Config } from '../../../core/types.js';
import { fail } from '../../../core/util/index.js';
import { containedAvailability } from '../contained/check.js';
import type { ContainedDeps } from '../contained/contained-storage.js';
import { FolderStorageProvider } from './folder.js';
import { ContainedStorageProvider } from './contained.js';
import type { ProviderCheck, StorageProvider } from './types.js';

export interface ProviderOptions {
  readonly contained?: ContainedDeps;
  /** Tests: the answer of the availability check. */
  readonly availability?: () => ProviderCheck;
}

export function providerFor(config: Config, options: ProviderOptions = {}): StorageProvider {
  if (config.storage.contained === 'off') return new FolderStorageProvider();
  const check = (options.availability ?? containedAvailability)();
  if (!check.available)
    fail(
      'Contained storage cannot be used: ' + check.reasons.join(' '),
      check.fixes.join(' ') || 'Set storage.contained to "off" (the default) in your settings.',
    );
  if (!options.contained)
    fail('Contained storage was not set up for this command.', 'Set storage.contained to "off" and report this.');
  return new ContainedStorageProvider(options.contained, undefined, options.availability);
}
