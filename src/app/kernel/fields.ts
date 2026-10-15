// One form model for every surface: any zod schema (an operation's input, the whole settings schema) becomes Field
// descriptors - the kind of input, its label and help (from .describe()), default, range, choices, whether it is a
// folder or a file. The menu's editors and the web's inputs both read Fields, so a new option or setting is editable
// everywhere as soon as it is in a schema. Fields are plain data (FieldSchema), so they can travel to the browser.
import { z } from 'zod';
import { SchemaNode } from './schema-node.js';
import { humanize } from './text.js';

export const FIELD_KINDS = [
  'boolean',
  'enum',
  'number',
  'text',
  'secret',
  'path',
  'list',
  'map',
  'object',
  'json',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** A folder or a file on this PC. */
export type PathKind = 'dir' | 'file';

export type ChoiceValue = string | number | boolean;

export interface Choice {
  readonly value: ChoiceValue;
  readonly label: string;
}

export interface Field {
  /** The last part of the key ('' for a whole schema). */
  readonly name: string;
  /** Where the value sits, from the root of the schema (settings: sandbox.memoryMb). */
  readonly key: readonly string[];
  readonly kind: FieldKind;
  readonly label: string;
  readonly help?: string;
  /** May be left out (it is optional or has a default). */
  readonly optional: boolean;
  /** The default (secrets: never sent; `***` when there is one). */
  readonly default?: unknown;
  /** enum: the values offered. */
  readonly choices?: readonly Choice[];
  /** enum: a value of your own is allowed too (a number, a text): typed as this field. */
  readonly open?: Field;
  /** number: the range and whether it must be whole; `range` says it in words ("1 to 365"). */
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly range?: string;
  /** path: a folder or a file; `literals` are words allowed instead of a path ("auto"). */
  readonly pathKind?: PathKind;
  readonly literals?: readonly string[];
  /** list / map: one entry. */
  readonly element?: Field;
  /** object: its fields, in schema order. */
  readonly fields?: readonly Field[];
}

const ChoiceValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/** The wire shape of a Field (validated wherever Fields arrive from elsewhere). */
export const FieldSchema: z.ZodType<Field> = z.lazy(() =>
  z.strictObject({
    name: z.string(),
    key: z.array(z.string()),
    kind: z.enum(FIELD_KINDS),
    label: z.string(),
    help: z.string().optional(),
    optional: z.boolean(),
    default: z.unknown().optional(),
    choices: z.array(z.strictObject({ value: ChoiceValueSchema, label: z.string() })).optional(),
    open: FieldSchema.optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().optional(),
    range: z.string().optional(),
    pathKind: z.enum(['dir', 'file']).optional(),
    literals: z.array(z.string()).optional(),
    element: FieldSchema.optional(),
    fields: z.array(FieldSchema).optional(),
  }),
);

/** Settings whose value (or list entries) are folders or files, besides the names that say so (…Dir, …File). */
const PATH_KINDS: Readonly<Record<string, PathKind>> = {
  'storage.root': 'dir',
  'projects.roots': 'dir',
  'projects.exclude': 'dir',
  'projects.declinedRoots': 'dir',
  'claudeProfile.hostDir': 'dir',
  'claudeProfile.globalStateFile': 'file',
  scripts: 'file',
};

/** The kind of path a value holds (its key without list positions), or undefined when it is not a path. */
export function pathKindOf(key: readonly string[]): PathKind | undefined {
  const id = key.join('.');
  const last = key[key.length - 1] ?? '';
  if (PATH_KINDS[id]) return PATH_KINDS[id];
  if (key[0] === 'mappings' && last === 'host') return 'dir';
  if (last === 'hostDir') return 'dir';
  if (/(Dir|Folder)$/.test(last)) return 'dir';
  if (/File$/.test(last)) return 'file';
  return undefined;
}

/** Words that are fine instead of a path ("auto"), read from the description. */
export function pathLiterals(node: SchemaNode): string[] {
  return /"auto"/.test(node.description ?? '') ? ['auto'] : [];
}

/** "On", "Off" or the value itself: how a choice is named. */
export function choiceLabel(v: unknown): string {
  return v === true ? 'On' : v === false ? 'Off' : String(v);
}

/** A real bound (zod reports none as ±Infinity or the safe-integer limits). */
function isLimit(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n) && Math.abs(n) < Number.MAX_SAFE_INTEGER;
}

/** The schema's default, if it has one. */
function defaultOf(node: SchemaNode): unknown {
  const def = node.schema._zod.def;
  return def.type === 'default' ? def.defaultValue : undefined;
}

/** The Field for a schema (or one part of it, `key` naming where it sits). */
export function fieldOf(schema: z.ZodType | SchemaNode, key: readonly string[] = [], label?: string): Field {
  const node = schema instanceof SchemaNode ? schema : new SchemaNode(schema);
  const name = key[key.length - 1] ?? '';
  const base = {
    name,
    key: [...key],
    label: label ?? (name ? humanize(name) : ''),
    ...(node.description ? { help: node.description } : {}),
    optional: node.optional,
  };
  const fallback = defaultOf(node);
  const withDefault = (secret: boolean): { default?: unknown } =>
    fallback === undefined ? {} : { default: secret ? (fallback === '' ? '' : '***') : fallback };
  switch (node.editor) {
    case 'boolean':
      return { ...base, kind: 'boolean', ...withDefault(false) };
    case 'choice':
    case 'union': {
      const open = node.openOption;
      return {
        ...base,
        kind: 'enum',
        ...withDefault(false),
        choices: node.choiceValues
          .filter((v): v is ChoiceValue => ['string', 'number', 'boolean'].includes(typeof v))
          .map((v) => ({ value: v, label: choiceLabel(v) })),
        ...(open ? { open: fieldOf(open, key, base.label) } : {}),
      };
    }
    case 'number': {
      const range = node.rangeText();
      return {
        ...base,
        kind: 'number',
        ...withDefault(false),
        ...(isLimit(node.min) ? { min: node.min } : {}),
        ...(isLimit(node.max) ? { max: node.max } : {}),
        ...(node.integer ? { integer: true } : {}),
        ...(range ? { range } : {}),
      };
    }
    case 'string': {
      if (node.secret) return { ...base, kind: 'secret', ...withDefault(true) };
      const pathKind = pathKindOf(key);
      if (pathKind) return { ...base, kind: 'path', ...withDefault(false), pathKind, literals: pathLiterals(node) };
      return { ...base, kind: 'text', ...withDefault(false) };
    }
    case 'string-list':
    case 'choice-list':
    case 'object-list':
      return { ...base, kind: 'list', ...withDefault(false), element: fieldOf(node.element!, key, 'Entry') };
    case 'string-map':
    case 'object-map':
      return { ...base, kind: 'map', ...withDefault(node.element?.secret ?? false), element: elementOf(node, key) };
    case 'object':
      return { ...base, kind: 'object', ...withDefault(false), fields: fieldsOf(node, key) };
    default:
      return { ...base, kind: 'json', ...withDefault(false) };
  }
}

/** A map's entry: named by its key, so it is not a path or secret by the map's own name alone. */
function elementOf(node: SchemaNode, key: readonly string[]): Field {
  return fieldOf(node.element!, [...key, '*'], 'Value');
}

/** The Fields of an object schema, in schema order (`key` = where the object sits). */
export function fieldsOf(schema: z.ZodType | SchemaNode, key: readonly string[] = []): Field[] {
  const node = schema instanceof SchemaNode ? schema : new SchemaNode(schema);
  return node.children().map(([name, child]) => fieldOf(child, [...key, name]));
}

/** A value in one short line, and the tone it is shown in (secrets as ***). */
export interface ValueText {
  readonly text: string;
  readonly tone?: 'ok' | 'muted';
}

/** A one-line name for an object in a list (a mapped folder, an agent's package ...). */
export function summary(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return String(value);
  const o = value as Record<string, unknown>;
  if (typeof o.host === 'string' && typeof o.guest === 'string')
    return o.host + ' → ' + o.guest + (o.readOnly ? ' (read-only)' : '');
  const strings = Object.values(o).filter((v): v is string => typeof v === 'string' && v !== '');
  return strings.slice(0, 2).join(' · ') || '{ ' + Object.keys(o).join(', ') + ' }';
}

/** Cuts text to `max` characters with an ellipsis. */
function cut(text: string, max: number): string {
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + '…' : text;
}

/** How a value reads in a list: On/Off, "not set", counts for lists and maps, *** for a secret. */
export function valueText(value: unknown, field?: Pick<Field, 'kind' | 'element'>, max = 60): ValueText {
  if (value === undefined) return { text: 'not set', tone: 'muted' };
  if (field?.kind === 'secret') return value === '' ? { text: '(empty)', tone: 'muted' } : { text: '***' };
  if (value === true) return { text: 'On', tone: 'ok' };
  if (value === false) return { text: 'Off', tone: 'muted' };
  if (value === null) return { text: 'none', tone: 'muted' };
  if (typeof value === 'string') return value === '' ? { text: '(empty)', tone: 'muted' } : { text: cut(value, max) };
  if (typeof value === 'number') return { text: String(value) };
  if (Array.isArray(value))
    return value.length === 0
      ? { text: 'none', tone: 'muted' }
      : {
          text: cut(
            value.length + ' · ' + value.map((v) => (typeof v === 'object' ? summary(v) : String(v))).join(', '),
            max,
          ),
        };
  const keys = Object.keys(value as object);
  return keys.length ? { text: cut(keys.length + ' · ' + keys.join(', '), max) } : { text: 'none', tone: 'muted' };
}

/** What was typed for a value as the value it stands for: true/false/on/off, a number, JSON, or plain text. */
export function valueFromText(node: SchemaNode, text: string): unknown {
  const word = text.trim().toLowerCase();
  if (node.type === 'string') return text;
  if (node.type === 'boolean' || node.options.some((o) => o.type === 'boolean')) {
    if (['true', 'on', 'yes'].includes(word)) return true;
    if (['false', 'off', 'no'].includes(word)) return false;
  }
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: a bare word such as auto or a path is the text itself.
    return node.type === 'array' ? text.split(',').map((t) => t.trim()) : text;
  }
}

/** What a value accepts, in words: its fixed values, a number and its range, true or false. */
export function allowedText(node: SchemaNode): string {
  if (node.type === 'boolean') return 'Use true or false.';
  const values = node.choiceValues.map((v) => String(v));
  const open = node.openOption ?? (node.type === 'number' ? node : undefined);
  const range = (n: SchemaNode): string => (n.rangeText() ? ' (' + n.rangeText() + ')' : '');
  const more = open ? (open.type === 'number' ? 'a number' + range(open) : 'text') : '';
  const parts = [...values, ...(more ? [more] : [])];
  return parts.length ? 'Allowed: ' + parts.join(', or ') + '.' : 'Check the value.';
}

/**
 * What is wrong with a value for a Field, as far as the Field can tell (required, a number in range, one of the
 * choices); undefined when nothing is. Forms check this as you type; the operation checks the value fully again.
 */
export function fieldProblem(field: Field, value: unknown): string | undefined {
  if (value === undefined || value === '') return field.optional || field.kind === 'text' ? undefined : 'Required.';
  if (field.kind === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return 'Enter a number.';
    if (field.integer && !Number.isInteger(n)) return 'Enter a whole number.';
    if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max))
      return field.range ? 'Use ' + field.range + '.' : 'Out of range.';
  }
  if (field.kind === 'enum' && !field.open && !field.choices?.some((c) => c.value === value)) return 'Choose one.';
  return undefined;
}
