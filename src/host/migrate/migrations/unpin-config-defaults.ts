// The first real migration. `config init` used to write every default into config.json, so files from 1.0.x pin values
// that have since changed (the toolchains now follow 'auto'). Removes the leaves that still hold an old default and
// differ from today's, so they follow the current default; anything the user changed stays, comments included.
import _ from 'lodash';
import { DEFAULTS } from '../../../core/config/index.js';
import type { Migration, MigrationContext } from '../migration.js';
import { fullSnapshots, readFileObject, removeValues, type Json } from './config-file.js';

/** Paths of the leaves of a JSON object (arrays and scalars are leaves). */
function leafPaths(value: unknown, prefix: string[] = []): string[][] {
  if (!_.isPlainObject(value)) return prefix.length ? [prefix] : [];
  return Object.entries(value as Json).flatMap(([key, child]) => leafPaths(child, [...prefix, key]));
}

/** Leaves that still hold an old default (from a full snapshot) and differ from today's default. */
function pinnedLeaves(file: Json): string[][] {
  const snapshots = fullSnapshots(file);
  return leafPaths(file).filter((path) => {
    const value = _.get(file, path);
    return (
      _.has(DEFAULTS, path) &&
      !_.isEqual(value, _.get(DEFAULTS, path)) &&
      snapshots.some((snapshot) => _.has(snapshot.defaults, path) && _.isEqual(_.get(snapshot.defaults, path), value))
    );
  });
}

export const unpinConfigDefaults: Migration = {
  id: '2026-10-unpin-config-defaults',
  introducedIn: '1.5.0',
  scope: 'user',
  needsIdleSandbox: false,
  summary: "Removes config.json values an old 'config init' pinned to that version's default, so they follow today's.",

  applies(ctx: MigrationContext): boolean {
    const file = readFileObject(ctx.configPath);
    return file !== null && pinnedLeaves(file).length > 0;
  },

  touches(ctx: MigrationContext): readonly string[] {
    return ctx.configPath ? [ctx.configPath] : [];
  },

  async run(ctx: MigrationContext, note: (line: string) => void): Promise<void> {
    const parsed = readFileObject(ctx.configPath);
    if (ctx.configPath && parsed) removeValues(ctx.configPath, pinnedLeaves(parsed), 'Now follows the default', note);
  },
};
