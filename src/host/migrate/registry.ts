// Every migration, oldest first. A new one is appended here; a shipped one is never edited or reordered.
import type { Migration } from './migration.js';
import { unpinConfigDefaults } from './migrations/unpin-config-defaults.js';

export const MIGRATIONS: readonly Migration[] = [unpinConfigDefaults];
