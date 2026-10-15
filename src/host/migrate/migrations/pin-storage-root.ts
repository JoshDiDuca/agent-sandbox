// 1.6 moves the default storage folder to %ProgramData%\AgentSandbox\users\<you>. Nobody's data may seem to vanish: a
// user with no storage.root of their own, no all-users install, and saved data in the old per-user folder keeps that
// folder, pinned in config.json. Moving it to the new default is offered later (sandbox storage).
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { machineConfigPath } from '../../../core/config/index.js';
import { holdsData, OLD_DEFAULT_ROOT, oldDefaultRoot } from '../../storage/root.js';
import type { Migration, MigrationContext } from '../migration.js';
import { readFileObject, setValue } from './config-file.js';

const ROOT = ['storage', 'root'];

/** The file the pin goes in: the user's config, or the one it would be (not created until the pin is written). */
function targetFile(ctx: MigrationContext): string {
  return ctx.configPath ?? path.join(ctx.userDir, 'config.json');
}

/** All the conditions of the migration, as a pure check on what is on disk. */
export function needsPin(file: string, machineFile: string, oldRoot: string | null): boolean {
  if (!oldRoot || !holdsData(oldRoot)) return false;
  const machine = readFileObject(machineFile);
  if (machine && _.has(machine, ROOT)) return false;
  if (!fs.existsSync(file)) return true;
  const parsed = readFileObject(file);
  // A file that cannot be read is left alone: editing it blindly could lose the user's settings.
  return parsed !== null && !_.has(parsed, ROOT);
}

export const pinStorageRoot: Migration = {
  id: '2026-10-pin-storage-root',
  introducedIn: '1.6.0',
  scope: 'user',
  needsIdleSandbox: false,
  summary: 'Keeps your saved data where it is (the old per-user folder), now that the default folder is a new one.',

  applies(ctx: MigrationContext): boolean {
    return needsPin(targetFile(ctx), machineConfigPath(), oldDefaultRoot());
  },

  touches(): readonly string[] {
    return [];
  },

  async run(ctx: MigrationContext, note: (line: string) => void): Promise<void> {
    if (!needsPin(targetFile(ctx), machineConfigPath(), oldDefaultRoot())) return;
    setValue(targetFile(ctx), ROOT, OLD_DEFAULT_ROOT);
    note('Your saved data stays in ' + OLD_DEFAULT_ROOT + ' (storage.root)');
  },
};
