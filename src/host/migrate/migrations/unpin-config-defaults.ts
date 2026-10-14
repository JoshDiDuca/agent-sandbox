// The first real migration. `config init` used to write every default into config.json, so files from 1.0.x pin values
// that have since changed (the toolchains now follow 'auto'). Removes the leaves that still hold an old default and
// differ from today's, so they follow the current default; anything the user changed stays, comments included.
import fs from 'node:fs';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import _ from 'lodash';
import { DEFAULTS } from '../../../core/config/index.js';
import { writeFileAtomic } from '../../../shared/io/index.js';
import type { Migration, MigrationContext } from '../migration.js';
import { DEFAULTS_SNAPSHOTS, type DefaultsSnapshot } from '../snapshots.js';

type Json = Record<string, unknown>;

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };

/** The parsed file, or null when it is missing or not valid JSON with comments (then there is nothing to recognise). */
function readFileObject(file: string | null): Json | null {
  if (!file || !fs.existsSync(file)) return null;
  const errors: ParseError[] = [];
  const value: unknown = parse(fs.readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
  return errors.length === 0 && _.isPlainObject(value) ? (value as Json) : null;
}

/** The snapshots of a full `config init` file: every top-level key of the snapshot is in the file. */
function fullSnapshots(file: Json): DefaultsSnapshot[] {
  return DEFAULTS_SNAPSHOTS.filter((snapshot) => Object.keys(snapshot.defaults).every((key) => key in file));
}

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
    const file = ctx.configPath;
    const parsed = readFileObject(file);
    if (!file || !parsed) return;
    let text = fs.readFileSync(file, 'utf8');
    for (const path of pinnedLeaves(parsed)) {
      text = applyEdits(text, modify(text, path, undefined, FORMAT));
      note('Now follows the default: ' + path.join('.'));
    }
    writeFileAtomic(file, text);
  },
};
