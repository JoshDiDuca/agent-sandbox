// The prompt that fits a setting's type. Returns the new value, or undefined to change nothing.
import { input, select } from '@inquirer/prompts';
import type { Config } from '../../core/types.js';
import { c } from '../colors.js';
import { jsonExample, kind, promptKind, unwrap, type Schema } from './schema.js';

export type Answer = { value: unknown } | undefined;

const CANCEL = '@cancel';
const cancel = { name: c.dim('< cancel'), value: CANCEL };

const pick = async (label: string, choices: { name: string; value: unknown }[], current: unknown): Promise<Answer> => {
  const v = await select<unknown>({ message: label, choices: [...choices, cancel], default: current });
  return v === CANCEL ? undefined : { value: v };
};

const typed = async (label: string, current: unknown, validate: (v: string) => true | string, convert: (v: string) => unknown): Promise<Answer> => {
  const shown = current === undefined ? '' : typeof current === 'string' ? current : JSON.stringify(current);
  const answer = await input({ message: label + c.dim(' (empty = cancel)'), default: shown, validate: (v) => (v === '' ? true : validate(v)) });
  return answer === '' ? undefined : { value: convert(answer) };
};

const BOOLEANS = [{ name: 'true', value: true }, { name: 'false', value: false }];

/** `key` is the setting's path; `config` (the user's settings) lets the default agent be picked from the configured ones. */
export const askValue = async (schema: Schema, key: string[], current: unknown, config?: Config): Promise<Answer> => {
  const label = key.join('.');
  const s = unwrap(schema);
  // The default agent is one of the configured ones: a list, not free text.
  if (label === 'defaultHarness' && config) return pick(label, Object.keys(config.harnesses).map((h) => ({ name: h, value: h })), current);
  switch (promptKind(s)) {
    case 'boolean': return pick(label, BOOLEANS, current);
    case 'enum': return pick(label, Object.values(s._zod.def.entries ?? {}).map((v) => ({ name: String(v), value: v })), current);
    case 'union': {
      const options = s._zod.def.options ?? [];
      const literals = options.filter((o) => kind(o) === 'literal').flatMap((o) => unwrap(o)._zod.def.values ?? []);
      const other = options.find((o) => !['literal', 'boolean'].includes(kind(o)));
      const choices = [...(options.some((o) => kind(o) === 'boolean') ? BOOLEANS : []), ...literals.map((v) => ({ name: String(v), value: v }))];
      if (!other) return pick(label, choices, current);
      const chosen = await pick(label, [...choices, { name: 'a ' + kind(other) + ' ...', value: '@other' }], current);
      return chosen?.value === '@other' ? askValue(other, key, current) : chosen;
    }
    case 'number': return typed(label, current, (v) => (Number.isFinite(Number(v)) ? true : 'Enter a number, e.g. 8192.'), Number);
    case 'string': return typed(label, current, () => true, (v) => v);
    case 'string-list': return typed(label + c.dim(' (comma separated, [] = none)'), current, () => true, (v) => (v.trim() === '[]' ? [] : v.split(',').map((x) => x.trim()).filter(Boolean)));
    default: return typed(label + c.dim(' (JSON, e.g. ' + jsonExample(key, s) + ')'), current, (v) => { try { JSON.parse(v); return true; } catch { return 'valid JSON'; } }, (v) => JSON.parse(v));
  }
};
