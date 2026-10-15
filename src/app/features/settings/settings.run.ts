// The settings feature's work: the rows of a scope, and one setting read, changed or reset. Files are changed one
// setting at a time with comments kept, and nothing is written unless the whole file stays valid (settings-file.ts).
import _ from 'lodash';
import { redactSecrets } from '../../../core/schema/index.js';
import { fail } from '../../../core/util/index.js';
import { hereDir } from '../../../cli/commands/projects/here.js';
import { implement, type AppContext } from '../../context.js';
import { allowedText, valueFromText } from '../../kernel/index.js';
import { CATEGORIES } from './categories.def.js';
import { ConfigFile } from './settings-file.js';
import { findSetting, masked, settingRows, type SettingsFiles } from './settings-rows.js';
import { getSetting, listSettings, resetSetting, setSetting, type Scope } from './settings.def.js';

/** Your own settings file (the one --config names) and the project file of the current folder. */
export function settingsFiles(ctx: AppContext): SettingsFiles {
  return { user: ConfigFile.user(ctx.loaded.configPath), project: ConfigFile.project(hereDir(ctx)) };
}

/** A typed or sent value as the setting reads it: text goes through the command line's rules (true/on, numbers ...). */
function valueFor(node: Parameters<typeof valueFromText>[0], value: unknown): unknown {
  return typeof value === 'string' ? valueFromText(node, value) : value;
}

export const listSettingsRun = implement(listSettings, (ctx, input) => {
  const files = settingsFiles(ctx);
  const file = files[input.scope];
  const rows = settingRows(files, input.scope).filter((r) => input.scope === 'project' || r.id !== 'storage.root');
  return {
    scope: input.scope,
    file: file.file,
    exists: file.exists,
    ...(input.scope === 'user' ? { dataFolder: ctx.storageRoot } : {}),
    categories: CATEGORIES.filter((c) => rows.some((r) => r.category === c.id)).map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
    })),
    rows,
  };
});

export const getSettingRun = implement(getSetting, (ctx, input) => {
  const file = settingsFiles(ctx).user;
  const { key } = findSetting(file, input.key);
  // Secret values (an agent's API keys) are never shown.
  return { key: input.key, value: _.get(redactSecrets(file.userConfig()), key) as unknown };
});

/** The file of a scope, and the setting a key names in it. */
function target(ctx: AppContext, scope: Scope, name: string): ReturnType<typeof findSetting> & { file: ConfigFile } {
  const file = settingsFiles(ctx)[scope];
  return { ...findSetting(file, name), file };
}

export const setSettingRun = implement(setSetting, (ctx, input) => {
  const { key, node, file } = target(ctx, input.scope, input.key);
  if (node.isSection)
    fail('"' + input.key + '" is a group of settings.', 'Set one of them, e.g. ' + node.leaves(key)[0]?.key.join('.'));
  const value = valueFor(node, input.value);
  const problem = node.check(value);
  if (problem !== true) {
    const typed = typeof input.value === 'string' ? input.value : JSON.stringify(masked(key, input.value));
    fail('"' + typed + '" does not work for ' + input.key + ': ' + problem, allowedText(node));
  }
  const outcome = file.set(key, value);
  if (typeof outcome === 'object')
    fail('Could not change ' + input.key + ': ' + outcome.problems.join('; '), 'Nothing was written.');
  return {
    key: input.key,
    changed: outcome === 'saved',
    message:
      input.key +
      ' is ' +
      JSON.stringify(masked(key, value)) +
      (outcome === 'unchanged' ? ' (it was already)' : '') +
      '.',
  };
});

export const resetSettingRun = implement(resetSetting, (ctx, input) => {
  const { key, file } = target(ctx, input.scope, input.key);
  const outcome = file.set(key, undefined);
  if (typeof outcome === 'object')
    fail('Could not reset ' + input.key + ': ' + outcome.problems.join('; '), 'Nothing was written.');
  return {
    key: input.key,
    changed: outcome === 'saved',
    message: file.isProject
      ? input.key + ' is not set in ' + file.file + ' any more.'
      : input.key + ' is back to its default: ' + JSON.stringify(masked(key, file.defaultOf(key))) + '.',
  };
});
