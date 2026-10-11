// Reading the zod settings schemas the way the settings screen needs: what is a section, what kind of prompt fits a
// setting. Nothing here is listed by hand, so a new setting shows up in the screen on its own.
import type { z } from 'zod';

export type Schema = z.ZodType & { _zod: { def: { type: string; options?: Schema[]; values?: unknown[]; entries?: Record<string, string>; element?: Schema; innerType?: Schema } }; shape?: Record<string, Schema>; description?: string };

/** optional()/default() wrappers hide the real type. */
export const unwrap = (s: Schema): Schema => (['optional', 'default', 'nullable'].includes(s._zod.def.type) && s._zod.def.innerType ? unwrap(s._zod.def.innerType) : s);
export const kind = (s: Schema): string => unwrap(s)._zod.def.type;
export const isSection = (s: Schema): boolean => kind(s) === 'object' && Boolean(unwrap(s).shape);

/** Settings not worth editing here (the schema link). */
const HIDDEN = new Set(['$schema']);

/** The settings one level below a section (or the top level), in schema order. */
export const childrenOf = (schema: Schema): [string, Schema][] => Object.entries(unwrap(schema).shape ?? {}).filter(([name]) => !HIDDEN.has(name));

/** The description, which `.partial()` and `.optional()` wrappers may carry on the inner schema instead. */
export const describeSetting = (s: Schema): string | undefined => s.description ?? unwrap(s).description;

/** Every setting that is edited with a prompt of its own (everything that is not a section), with its path. */
export const leavesOf = (schema: Schema, key: string[] = []): { key: string[]; schema: Schema }[] =>
  childrenOf(schema).flatMap(([name, child]) => (isSection(child) ? leavesOf(child, [...key, name]) : [{ key: [...key, name], schema: child }]));

export type PromptKind = 'boolean' | 'enum' | 'union' | 'number' | 'string' | 'string-list' | 'json';

/** Which prompt edits this setting. Lists of objects and maps (mappings, harnesses, environment) fall back to JSON. */
export const promptKind = (schema: Schema): PromptKind => {
  const s = unwrap(schema);
  const type = s._zod.def.type;
  if (type === 'boolean' || type === 'enum' || type === 'union' || type === 'number' || type === 'string') return type;
  if (type === 'array' && s._zod.def.element && kind(s._zod.def.element) === 'string') return 'string-list';
  return 'json';
};

const JSON_EXAMPLES: Record<string, string> = {
  harnesses: '{"mytool": {"npmPackage": "my-cli", "npmBin": "my-cli", "arguments": [], "environment": {}}}',
  mappings: '[{"host": "C:\\\\data", "guest": "C:\\\\Data", "readOnly": true}]',
  environment: '{"NPM_CONFIG_REGISTRY": "https://registry.example.com"}',
};

/** A one-line example of the JSON a setting expects, shown in its prompt. */
export const jsonExample = (key: string[], schema: Schema): string =>
  JSON_EXAMPLES[key[key.length - 1]] ?? (unwrap(schema)._zod.def.type === 'array' ? '["value", ...]' : '{"name": "value"}');
