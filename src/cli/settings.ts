// The settings screen in the menu: every setting, generated from the zod schema (so nothing needs to be listed by
// hand), shown with its current value and description, edited with a fitting prompt and saved to the user config
// file. Edits go through jsonc-parser, so comments and formatting in the file are kept, and nothing is written unless
// the whole config is still valid.
import fs from 'node:fs';
import path from 'node:path';
import { input, select, Separator } from '@inquirer/prompts';
import { applyEdits, modify, parse } from 'jsonc-parser';
import _ from 'lodash';
import type { z } from 'zod';
import { DEFAULTS, loadConfig, mergeConfig, userConfigPath } from '../core/config.js';
import { Config as ConfigSchema, describeIssues } from '../core/schema.js';
import type { Config } from '../core/types.js';

type Schema = z.ZodType & { _zod: { def: { type: string; options?: Schema[]; values?: unknown[]; entries?: Record<string, string>; element?: Schema; innerType?: Schema } }; shape?: Record<string, Schema>; description?: string };

const c = { dim: (s: string) => '\x1b[2m' + s + '\x1b[0m', cyan: (s: string) => '\x1b[36m' + s + '\x1b[0m', green: (s: string) => '\x1b[32m' + s + '\x1b[0m', yellow: (s: string) => '\x1b[33m' + s + '\x1b[0m', red: (s: string) => '\x1b[31m' + s + '\x1b[0m' };

/** optional()/default() wrappers hide the real type. */
const unwrap = (s: Schema): Schema => (['optional', 'default', 'nullable'].includes(s._zod.def.type) && s._zod.def.innerType ? unwrap(s._zod.def.innerType) : s);
const kind = (s: Schema): string => unwrap(s)._zod.def.type;
const isSection = (s: Schema): boolean => kind(s) === 'object' && Boolean(unwrap(s).shape);

/** Settings not worth editing here (the schema link) or better edited in the file (agent definitions). */
const HIDDEN = new Set(['$schema']);

/** A value in one short line: maps as their keys, long lists shortened. */
const show = (value: unknown): string => {
  if (value === undefined) return c.dim('(not set)');
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) { const keys = Object.keys(value); return keys.length ? '{ ' + _.truncate(keys.join(', '), { length: 60 }) + ' }' : '{}'; }
  return _.truncate(JSON.stringify(value), { length: 70 });
};

/** What the value is in the file the user owns (undefined when it comes from the built-in defaults). */
const fileValue = (text: string, key: string[]): unknown => _.get(parse(text) ?? {}, key);

/**
 * Applies one change (undefined = back to the default) to the config text and returns the new text, or the problems
 * that make the result invalid. Pure: the caller writes the file.
 */
export const editConfigText = (text: string, key: string[], value: unknown): { text: string } | { problems: string[] } => {
  const edits = modify(text || '{}', key, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } });
  const next = applyEdits(text || '{}', edits);
  const parsed = ConfigSchema.safeParse(mergeConfig(DEFAULTS, parse(next) ?? {}));
  return parsed.success ? { text: next.endsWith('\n') ? next : next + '\n' } : { problems: describeIssues(parsed.error) };
};

/** A prompt that fits the setting's type; returns the new value, or undefined to change nothing. */
const askValue = async (schema: Schema, label: string, current: unknown, config?: Config): Promise<{ value: unknown } | undefined> => {
  const s = unwrap(schema);
  // The default agent is one of the configured ones: a list, not free text.
  if (label === 'defaultHarness' && config) {
    const v = await select<string>({ message: label, choices: [...Object.keys(config.harnesses).map((h) => ({ name: h, value: h })), { name: c.dim('< cancel'), value: '@cancel' }], default: current as string });
    return v === '@cancel' ? undefined : { value: v };
  }
  const t = s._zod.def.type;
  const back = { name: c.dim('< cancel'), value: '@cancel' };
  const pick = async (choices: { name: string; value: unknown }[]): Promise<{ value: unknown } | undefined> => {
    const v = await select<unknown>({ message: label, choices: [...choices, back], default: current });
    return v === '@cancel' ? undefined : { value: v };
  };
  if (t === 'boolean') return pick([{ name: 'true', value: true }, { name: 'false', value: false }]);
  if (t === 'enum') return pick(Object.values(s._zod.def.entries ?? {}).map((v) => ({ name: String(v), value: v })));
  if (t === 'union') {
    const options = s._zod.def.options ?? [];
    const literals = options.filter((o) => kind(o) === 'literal').flatMap((o) => unwrap(o)._zod.def.values ?? []);
    const hasBool = options.some((o) => kind(o) === 'boolean');
    const other = options.find((o) => !['literal', 'boolean'].includes(kind(o)));
    const choices = [...(hasBool ? [{ name: 'true', value: true }, { name: 'false', value: false }] : []), ...literals.map((v) => ({ name: String(v), value: v }))];
    if (!other) return pick(choices);
    const chosen = await pick([...choices, { name: 'a ' + kind(other) + ' ...', value: '@other' }]);
    return chosen?.value === '@other' ? askValue(other, label, current) : chosen;
  }
  const typed = async (validate: (v: string) => true | string, convert: (v: string) => unknown): Promise<{ value: unknown } | undefined> => {
    const answer = await input({ message: label + c.dim(' (empty = cancel)'), default: current === undefined ? '' : typeof current === 'string' ? current : JSON.stringify(current), validate: (v) => (v === '' ? true : validate(v)) });
    return answer === '' ? undefined : { value: convert(answer) };
  };
  if (t === 'number') return typed((v) => (Number.isFinite(Number(v)) ? true : 'a number'), Number);
  if (t === 'string') return typed(() => true, (v) => v);
  if (t === 'array' && kind(s._zod.def.element as Schema) === 'string') {
    return typed(() => true, (v) => (v.trim() === '[]' ? [] : v.split(',').map((x) => x.trim()).filter(Boolean)));
  }
  // Lists of objects and maps (mappings, harnesses, environment): edited as JSON.
  return typed((v) => { try { JSON.parse(v); return true; } catch { return 'valid JSON'; } }, (v) => JSON.parse(v));
};

/** Edits one setting: shows it, asks, saves (or resets it to the default). */
const editSetting = async (schema: Schema, key: string[], config: Config, file: string): Promise<void> => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const inFile = fileValue(text, key);
  console.log('\n' + c.cyan(key.join('.')) + (schema.description ? '\n' + c.dim(schema.description) : ''));
  console.log('Now: ' + show(_.get(config, key)) + (inFile === undefined ? c.dim('  (built-in default)') : c.dim('  (set in ' + file + ')')));
  const action = inFile === undefined ? 'change' : await select({ message: 'What now?', choices: [{ name: 'Change it', value: 'change' }, { name: 'Reset to the default (' + show(_.get(DEFAULTS, key)) + ')', value: 'reset' }, { name: c.dim('< back'), value: 'back' }] });
  if (action === 'back') return;
  const answer = action === 'reset' ? { value: undefined } : await askValue(schema, key.join('.'), _.get(config, key), config);
  if (!answer) return;
  // The default needs no line in the file; an unchanged value needs no save.
  const value = _.isEqual(answer.value, _.get(DEFAULTS, key)) ? undefined : answer.value;
  if (value === inFile && _.isEqual(answer.value, _.get(config, key))) { console.log(c.dim('Unchanged.')); return; }
  const result = editConfigText(text, key, value);
  if ('problems' in result) { console.log(c.red('Not saved: ') + result.problems.join('; ')); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, result.text, 'utf8');
  console.log(c.green('Saved') + c.dim(' to ' + file + '. New sandboxes use it.'));
};

const SECTION_TITLES: Record<string, string> = {
  toolchains: 'Languages and tools', databases: 'Databases', sandbox: 'The sandbox machine (memory, window, GPU, network)', attach: 'Attaching (auto attach, auto hide)',
  provisioning: 'Provisioning and git', secrets: 'Secrets', claudeProfile: 'Your Claude settings and history', storage: 'Storage', network: 'Network', hooks: 'Hooks', personalization: 'Desktop look',
};

/** Browses one level of settings; sections open, leaves are edited. */
const browse = async (schema: Schema, key: string[], file: string): Promise<void> => {
  for (;;) {
    const config = loadConfig(fs.existsSync(file) ? file : undefined).config;
    const entries = Object.entries(unwrap(schema).shape ?? {}).filter(([name]) => !HIDDEN.has(name));
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const pickName = await select<string>({
      message: key.length ? key.join('.') : 'Settings ' + c.dim('(saved to ' + file + ')'),
      pageSize: 18,
      choices: [
        ...entries.map(([name, s]) => {
          const full = [...key, name];
          const changed = fileValue(text, full) !== undefined;
          const label = isSection(s) ? (key.length ? name : SECTION_TITLES[name] ?? name) + c.dim(' ...') : name.padEnd(18) + ' ' + (changed ? c.yellow(show(_.get(config, full))) : show(_.get(config, full)));
          return { name: label, value: name, description: s.description };
        }),
        new Separator(),
        { name: c.dim('< back'), value: '@back' },
      ],
    });
    if (pickName === '@back') return;
    const child = unwrap(schema).shape![pickName];
    if (isSection(child)) await browse(child, [...key, pickName], file);
    else await editSetting(child, [...key, pickName], config, file);
  }
};

/** The settings screen. Changes are saved to the user config file (created when missing). */
export const settingsMenu = async (configPath: string | null): Promise<void> => {
  const file = configPath ?? userConfigPath();
  await browse(ConfigSchema as unknown as Schema, [], file);
};
