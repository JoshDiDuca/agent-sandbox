// Changing your own config file from a command (sandbox projects ..., the "add this root?" question): one setting at
// a time through the settings editor, so comments and formatting stay and an invalid result is never written.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import _ from 'lodash';
import { userConfigPath } from '../../core/config/index.js';
import { fail } from '../../core/util/index.js';
import { editConfigText } from '../../app/features/settings/index.js';
import type { Context } from './context.js';

export function configFile(ctx: Context): string {
  return ctx.loaded.configPath ?? userConfigPath();
}

/** The value as written in your file (not merged with the defaults). */
export function fileSetting<T>(ctx: Context, key: string[], fallback: T): T {
  const file = configFile(ctx);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return (_.get(parse(text) ?? {}, key) as T | undefined) ?? fallback;
}

export function setSetting(ctx: Context, key: string[], value: unknown): void {
  const file = configFile(ctx);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const result = editConfigText(text, key, value);
  if ('problems' in result)
    fail(
      'Could not change ' + key.join('.') + ':\n  ' + result.problems.join('\n  '),
      'Nothing was written. Fix the value, or the settings file: ' + file,
    );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, result.text, 'utf8');
}

/** Adds a folder to a list setting (projects.roots, projects.exclude, ...) unless it is there already. */
export function addToList(ctx: Context, key: string[], folder: string): boolean {
  const list = fileSetting<string[]>(ctx, key, []);
  if (list.some((p) => path.resolve(p).toLowerCase() === path.resolve(folder).toLowerCase())) return false;
  setSetting(ctx, key, [...list, folder]);
  return true;
}

export function removeFromList(ctx: Context, key: string[], folder: string): boolean {
  const list = fileSetting<string[]>(ctx, key, []);
  const rest = list.filter((p) => path.resolve(p).toLowerCase() !== path.resolve(folder).toLowerCase());
  if (rest.length === list.length) return false;
  setSetting(ctx, key, rest);
  return true;
}
