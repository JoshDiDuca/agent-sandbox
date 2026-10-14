// Reading and editing a config.json (JSON with comments) for the migrations: removing a value keeps every comment.
import fs from 'node:fs';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import _ from 'lodash';
import { writeFileAtomic } from '../../../shared/io/index.js';
import { DEFAULTS_SNAPSHOTS, type DefaultsSnapshot } from '../snapshots.js';

export type Json = Record<string, unknown>;

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };

/** The parsed file, or null when it is missing or not valid JSON with comments (then there is nothing to recognise). */
export function readFileObject(file: string | null): Json | null {
  if (!file || !fs.existsSync(file)) return null;
  const errors: ParseError[] = [];
  const value: unknown = parse(fs.readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
  return errors.length === 0 && _.isPlainObject(value) ? (value as Json) : null;
}

/** The snapshots of a full `config init` file: every top-level key of the snapshot is in the file. */
export function fullSnapshots(file: Json): DefaultsSnapshot[] {
  return DEFAULTS_SNAPSHOTS.filter((snapshot) => Object.keys(snapshot.defaults).every((key) => key in file));
}

/** Removes these values from the file, comments and the rest untouched, noting `why: <key>` for each. */
export function removeValues(
  file: string,
  paths: readonly string[][],
  why: string,
  note: (line: string) => void,
): void {
  let text = fs.readFileSync(file, 'utf8');
  for (const path of paths) {
    text = applyEdits(text, modify(text, path, undefined, FORMAT));
    note(why + ': ' + path.join('.'));
  }
  writeFileAtomic(file, text);
}
