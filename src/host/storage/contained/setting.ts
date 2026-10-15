// Writes storage.contained into the settings file (keeping its comments), the way `storage move` pins storage.root.
import { setValue } from '../../migrate/migrations/config-file.js';

export function writeContainedSetting(configFile: string, value: 'off' | 'vhdx'): void {
  setValue(configFile, ['storage', 'contained'], value);
}
