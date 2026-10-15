// Editing one value with the screen that fits it: on/off flips, choices are picked from a list, numbers and text are
// typed and checked as you type, lists and maps get an editor of their own (add, change, remove), and objects (a
// mapped folder, an agent) open as a small form. JSON is only the last resort for shapes none of these fit.
import _ from 'lodash';
import { type App, Text } from '../../tui/index.js';
import { type SchemaNode } from './schema-node.js';
import { choiceLabel } from './format.js';
import { StringListEditor } from './collections/string-list-editor.js';
import { MapEditor } from './collections/map-editor.js';
import { ObjectListEditor } from './collections/object-list-editor.js';
import { ObjectMapEditor } from './collections/object-map-editor.js';
import { ObjectEditor } from './object-editor.js';
import { askPath, pathKindOf, pathLiterals } from './path-kind.js';

/** What is wrong with the text typed for a number setting (true = fine), in words that name the allowed range. */
export function numberProblem(node: SchemaNode, text: string): true | string {
  const n = Number(text);
  if (text.trim() === '' || !Number.isFinite(n)) return 'Enter a number.';
  if (node.integer && !Number.isInteger(n)) return 'Enter a whole number.';
  const verdict = node.check(n);
  if (verdict === true) return true;
  const range = node.rangeText();
  return range ? 'Use ' + range + '.' : verdict;
}

/** The new value, or undefined when you backed out without changing anything. */
export type Edited = { value: unknown } | undefined;

/** Optional extra knowledge: values to suggest for some settings (the configured agents for defaultHarness). */
export interface EditorHints {
  suggestions?: (key: string[]) => string[] | undefined;
}

export class ValueEditor {
  constructor(
    private readonly app: App,
    private readonly hints: EditorHints = {},
  ) {}

  async edit(path: string[], key: string[], node: SchemaNode, current: unknown): Promise<Edited> {
    const about = node.description ? [node.description] : [];
    const suggestions = this.hints.suggestions?.(key);
    if (suggestions?.length && node.type === 'string') return this.suggest(path, key, node, current, suggestions);
    switch (node.editor) {
      case 'boolean':
        return { value: !(current ?? false) };
      case 'choice':
        return this.pick(path, node, current, node.choiceValues);
      case 'union': {
        const open = node.openOption;
        const custom = '@custom';
        const picked = await this.app.choose(
          path,
          node.description ?? '',
          [
            ...node.choiceValues.map((v) => ({ value: v as unknown, label: choiceLabel(v) })),
            ...(open
              ? [
                  {
                    value: custom as unknown,
                    label: 'Custom ' + open.type + '…',
                    description: 'Type a ' + open.type + ' of your own.',
                  },
                ]
              : []),
          ],
          node.choiceValues.includes(current) ? current : open && current !== undefined ? custom : undefined,
        );
        if (picked === undefined) return undefined;
        return picked === custom && open
          ? this.edit(path, key, open, node.choiceValues.includes(current) ? undefined : current)
          : { value: picked };
      }
      case 'number':
        return this.number(path, key, node, current);
      case 'string': {
        const kind = pathKindOf(key);
        if (kind) return this.folderOrFile(path, key, node, current, kind);
        const typed = await this.app.text({
          path,
          label: Text.humanize(key[key.length - 1]),
          about,
          initial: typeof current === 'string' ? current : '',
          allowEmpty: node.check('') === true,
          masked: node.secret,
          validate: (v) => node.check(v),
        });
        return typed === undefined ? undefined : { value: typed };
      }
      case 'choice-list': {
        const ticked = Array.isArray(current) ? current : [];
        const picked = await this.app.list<unknown>({
          path,
          intro: node.description,
          multi: true,
          items: node.element!.choices.map((v) => ({ value: v, label: String(v), checked: ticked.includes(v) })),
        });
        return picked.kind === 'multi' ? { value: picked.values } : undefined;
      }
      case 'string-list':
        return new StringListEditor(this.app, path, node, this, key, pathKindOf(key)).run(
          Array.isArray(current) ? (current as string[]) : [],
        );
      case 'string-map':
        return new MapEditor(this.app, path, node, this, key).run(
          _.isPlainObject(current) ? (current as Record<string, unknown>) : {},
        );
      case 'object-list':
        return new ObjectListEditor(this.app, path, node, this, key).run(
          Array.isArray(current) ? (current as Record<string, unknown>[]) : [],
        );
      case 'object-map':
        return new ObjectMapEditor(this.app, path, node, this, key).run(
          _.isPlainObject(current) ? (current as Record<string, Record<string, unknown>>) : {},
        );
      case 'object':
        return new ObjectEditor(this.app, path, node, this, key).run(
          _.isPlainObject(current) ? (current as Record<string, unknown>) : (node.initial() as Record<string, unknown>),
        );
      default:
        return this.json(path, key, node, current);
    }
  }

  private async number(path: string[], key: string[], node: SchemaNode, current: unknown): Promise<Edited> {
    const range = node.rangeText();
    const typed = await this.app.text({
      path,
      label: Text.humanize(key[key.length - 1]),
      about: node.description ? [node.description] : [],
      hint: 'A ' + (node.integer ? 'whole number' : 'number') + (range ? ': ' + range : '') + '.',
      accept: node.integer ? (node.min !== undefined && node.min >= 0 ? /[0-9]/ : /[-0-9]/) : /[-0-9.]/,
      initial: current === undefined ? '' : String(current),
      validate: (v) => numberProblem(node, v),
    });
    return typed === undefined ? undefined : { value: Number(typed) };
  }

  /** A folder or file on this PC: the path picker (typing a path still works). */
  private async folderOrFile(
    path: string[],
    key: string[],
    node: SchemaNode,
    current: unknown,
    kind: 'dir' | 'file',
  ): Promise<Edited> {
    const picked = await askPath(this.app, {
      path,
      title: 'Choose ' + (kind === 'file' ? 'the file' : 'the folder') + ': ' + Text.humanize(key[key.length - 1]),
      about: node.description ? [node.description] : [],
      kind,
      initial: typeof current === 'string' && current !== 'auto' ? current : '',
      literals: pathLiterals(node),
      validate: (v) => node.check(v),
    });
    return picked === undefined ? undefined : { value: picked };
  }

  private async pick(path: string[], node: SchemaNode, current: unknown, values: unknown[]): Promise<Edited> {
    const picked = await this.app.choose(
      path,
      node.description ?? '',
      values.map((v) => ({ value: v, label: choiceLabel(v) })),
      current,
    );
    return picked === undefined ? undefined : { value: picked };
  }

  private async suggest(
    path: string[],
    key: string[],
    node: SchemaNode,
    current: unknown,
    suggestions: string[],
  ): Promise<Edited> {
    const other = '@other';
    const picked = await this.app.choose<string>(
      path,
      node.description ?? '',
      [
        ...suggestions.map((s) => ({ value: s, label: s })),
        { value: other, label: 'Other…', description: 'Type a name that is not in the list.' },
      ],
      typeof current === 'string' ? current : undefined,
    );
    if (picked === undefined) return undefined;
    if (picked !== other) return { value: picked };
    const typed = await this.app.text({
      path,
      label: Text.humanize(key[key.length - 1]),
      initial: typeof current === 'string' ? current : '',
      validate: (v) => node.check(v),
    });
    return typed === undefined ? undefined : { value: typed };
  }

  private async json(path: string[], key: string[], node: SchemaNode, current: unknown): Promise<Edited> {
    const typed = await this.app.text({
      path,
      label: Text.humanize(key[key.length - 1]) + ' (JSON)',
      about: node.description ? [node.description] : [],
      initial: current === undefined ? '' : JSON.stringify(current),
      validate: (v) => {
        try {
          return node.check(JSON.parse(v));
        } catch {
          return 'This is not valid JSON.';
        }
      },
    });
    return typed === undefined ? undefined : { value: JSON.parse(typed) };
  }
}
