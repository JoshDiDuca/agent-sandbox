// Editing one value with the screen that fits it: on/off flips, choices are picked from a list, numbers and text are
// typed and checked as you type, lists and maps get an editor of their own (add, change, remove), and objects (a
// mapped folder, an agent) open as a small form. JSON is only the last resort for shapes none of these fit.
import _ from 'lodash';
import { App, Text } from '../../tui/index.js';
import { SchemaNode } from './schema-node.js';
import { choiceLabel } from './format.js';
import { StringListEditor } from './collections/string-list-editor.js';
import { MapEditor } from './collections/map-editor.js';
import { ObjectListEditor } from './collections/object-list-editor.js';
import { ObjectMapEditor } from './collections/object-map-editor.js';
import { ObjectEditor } from './object-editor.js';

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
      case 'number': {
        const range =
          node.min !== undefined || node.max !== undefined
            ? ' (' + (node.min ?? '…') + ' to ' + (node.max ?? '…') + ')'
            : '';
        const typed = await this.app.text({
          path,
          label: Text.humanize(key[key.length - 1]) + range,
          about,
          initial: current === undefined ? '' : String(current),
          validate: (v) => (v.trim() === '' || !Number.isFinite(Number(v)) ? 'Enter a number.' : node.check(Number(v))),
        });
        return typed === undefined ? undefined : { value: Number(typed) };
      }
      case 'string': {
        const typed = await this.app.text({
          path,
          label: Text.humanize(key[key.length - 1]),
          about,
          initial: typeof current === 'string' ? current : '',
          allowEmpty: node.check('') === true,
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
        return new StringListEditor(this.app, path, node, this).run(
          Array.isArray(current) ? (current as string[]) : [],
        );
      case 'string-map':
        return new MapEditor(this.app, path, node, this).run(
          _.isPlainObject(current) ? (current as Record<string, unknown>) : {},
        );
      case 'object-list':
        return new ObjectListEditor(this.app, path, node, this).run(
          Array.isArray(current) ? (current as Record<string, unknown>[]) : [],
        );
      case 'object-map':
        return new ObjectMapEditor(this.app, path, node, this).run(
          _.isPlainObject(current) ? (current as Record<string, Record<string, unknown>>) : {},
        );
      case 'object':
        return new ObjectEditor(this.app, path, node, this).run(
          _.isPlainObject(current) ? (current as Record<string, unknown>) : (node.initial() as Record<string, unknown>),
        );
      default:
        return this.json(path, key, node, current);
    }
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
