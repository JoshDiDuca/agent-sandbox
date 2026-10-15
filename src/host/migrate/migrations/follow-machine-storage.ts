// An all-users install keeps everyone's data under %ProgramData%\AgentSandbox (its machine config says where), so a
// sandbox can be shared. A config.json written by an old `config init` pins storage.root to the old per-user default,
// which wins over the machine config. Removes that pin, and only that: a storage.root you chose yourself stays.
import path from 'node:path';
import _ from 'lodash';
import { DEFAULTS, machineConfigPath } from '../../../core/config/index.js';
import { expandPath } from '../../../core/util/index.js';
import { holdsData } from '../../storage/root.js';
import type { Migration, MigrationContext } from '../migration.js';
import { fullSnapshots, readFileObject, removeValues } from './config-file.js';

const ROOT = ['storage', 'root'];

/** True when the machine config sets the storage folder and the user's file only pins a default of an old init. */
function pinnedOverMachine(configPath: string | null): boolean {
  const machine = readFileObject(machineConfigPath());
  if (!machine || !_.has(machine, ROOT)) return false;
  const file = readFileObject(configPath);
  if (!file || !_.has(file, ROOT)) return false;
  const value = _.get(file, ROOT);
  const defaults = [_.get(DEFAULTS, ROOT), ...fullSnapshots(file).map((s) => _.get(s.defaults, ROOT))];
  if (!defaults.some((d) => _.isEqual(d, value))) return false;
  // A pin that holds your saved data while the shared folder has none is kept: sandbox storage offers the move.
  const pinned = typeof value === 'string' ? expandPath(value, path.dirname(configPath ?? '')) : '';
  const shared = expandPath(String(_.get(machine, ROOT)), path.dirname(machineConfigPath()));
  return !(holdsData(pinned) && !holdsData(shared));
}

export const followMachineStorage: Migration = {
  id: '2026-10-follow-machine-storage',
  introducedIn: '1.5.0',
  scope: 'user',
  needsIdleSandbox: true,
  summary:
    "Under an all-users install, removes the storage folder an old 'config init' pinned, so the shared one is used.",

  applies(ctx: MigrationContext): boolean {
    return pinnedOverMachine(ctx.configPath);
  },

  touches(ctx: MigrationContext): readonly string[] {
    return ctx.configPath ? [ctx.configPath] : [];
  },

  async run(ctx: MigrationContext, note: (line: string) => void): Promise<void> {
    if (ctx.configPath && pinnedOverMachine(ctx.configPath))
      removeValues(ctx.configPath, [ROOT], 'Now follows the all-users install', note);
  },
};
