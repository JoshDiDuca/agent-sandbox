// Editing one value with the screen that fits it: on/off flips, choices are picked from a list, numbers and text are
// typed and checked as you type, lists and maps get an editor of their own (add, change, remove), and objects (a
// mapped folder, an agent) open as a small form. JSON is only the last resort for shapes none of these fit.
import _ from 'lodash';
import { App, Text, Theme, type ListItem } from '../../tui/index.js';
import { SchemaNode } from './schema-node.js';

/** The new value, or undefined when you backed out without changing anything. */
export type Edited = { value: unknown } | undefined;

/** A value in one short line, for the right-hand column. */
export const formatValue = (value: unknown, max = 60): string => {
  if (value === undefined) return Theme.muted('not set');
  if (value === true) return Theme.ok('On');
  if (value === false) return Theme.muted('Off');
  if (value === null) return Theme.muted('none');
  if (typeof value === 'string') return value === '' ? Theme.muted('(empty)') : Text.truncate(value, max);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? Theme.muted('none') : Text.truncate(value.length + ' · ' + value.map((v) => (typeof v === 'object' ? summary(v) : String(v))).join(', '), max);
  const keys = Object.keys(value as object);
  return keys.length ? Text.truncate(keys.length + ' · ' + keys.join(', '), max) : Theme.muted('none');
};

/** A one-line name for an object in a list (a mapping's folders, an agent's package ...). */
const summary = (value: unknown): string => {
  if (!_.isPlainObject(value)) return String(value);
  const o = value as Record<string, unknown>;
  const strings = Object.entries(o).filter(([, v]) => typeof v === 'string' && v) as [string, string][];
  if (typeof o.host === 'string' && typeof o.guest === 'string') return o.host + ' → ' + o.guest + (o.readOnly ? ' (read-only)' : '');
  return strings.slice(0, 2).map(([, v]) => v).join(' · ') || '{ ' + Object.keys(o).join(', ') + ' }';
};

const choiceLabel = (v: unknown): string => (v === true ? 'On' : v === false ? 'Off' : String(v));

/** Optional extra knowledge: values to suggest for some settings (the configured agents for defaultHarness). */
export interface EditorHints { suggestions?: (key: string[]) => string[] | undefined }

export class ValueEditor {
  constructor(private readonly app: App, private readonly hints: EditorHints = {}) {}

  async edit(path: string[], key: string[], node: SchemaNode, current: unknown): Promise<Edited> {
    const about = node.description ? [node.description] : [];
    const suggestions = this.hints.suggestions?.(key);
    if (suggestions?.length && node.type === 'string') return this.suggest(path, key, node, current, suggestions);
    switch (node.editor) {
      case 'boolean': return { value: !(current ?? false) };
      case 'choice': return this.pick(path, node, current, node.choiceValues);
      case 'union': {
        const open = node.openOption;
        const custom = '@custom';
        const picked = await this.app.choose(path, node.description ?? '', [...node.choiceValues.map((v) => ({ value: v as unknown, label: choiceLabel(v) })), ...(open ? [{ value: custom as unknown, label: 'Custom ' + open.type + '…', description: 'Type a ' + open.type + ' of your own.' }] : [])], node.choiceValues.includes(current) ? current : open && current !== undefined ? custom : undefined);
        if (picked === undefined) return undefined;
        return picked === custom && open ? this.edit(path, key, open, node.choiceValues.includes(current) ? undefined : current) : { value: picked };
      }
      case 'number': {
        const range = node.min !== undefined || node.max !== undefined ? ' (' + (node.min ?? '…') + ' to ' + (node.max ?? '…') + ')' : '';
        const typed = await this.app.text({ path, label: Text.humanize(key[key.length - 1]) + range, about, initial: current === undefined ? '' : String(current), validate: (v) => (v.trim() === '' || !Number.isFinite(Number(v)) ? 'Enter a number.' : node.check(Number(v))) });
        return typed === undefined ? undefined : { value: Number(typed) };
      }
      case 'string': {
        const typed = await this.app.text({ path, label: Text.humanize(key[key.length - 1]), about, initial: typeof current === 'string' ? current : '', allowEmpty: node.check('') === true, validate: (v) => node.check(v) });
        return typed === undefined ? undefined : { value: typed };
      }
      case 'choice-list': {
        const ticked = Array.isArray(current) ? current : [];
        const picked = await this.app.list<unknown>({ path, intro: node.description, multi: true, items: node.element!.choices.map((v) => ({ value: v, label: String(v), checked: ticked.includes(v) })) });
        return picked.kind === 'multi' ? { value: picked.values } : undefined;
      }
      case 'string-list': return new StringListEditor(this.app, path, node, this).run(Array.isArray(current) ? current as string[] : []);
      case 'string-map': return new MapEditor(this.app, path, node, this).run(_.isPlainObject(current) ? current as Record<string, unknown> : {});
      case 'object-list': return new ObjectListEditor(this.app, path, node, this).run(Array.isArray(current) ? current as Record<string, unknown>[] : []);
      case 'object-map': return new ObjectMapEditor(this.app, path, node, this).run(_.isPlainObject(current) ? current as Record<string, Record<string, unknown>> : {});
      case 'object': return new ObjectEditor(this.app, path, node, this).run(_.isPlainObject(current) ? current as Record<string, unknown> : node.initial() as Record<string, unknown>);
      default: return this.json(path, key, node, current);
    }
  }

  private async pick(path: string[], node: SchemaNode, current: unknown, values: unknown[]): Promise<Edited> {
    const picked = await this.app.choose(path, node.description ?? '', values.map((v) => ({ value: v, label: choiceLabel(v) })), current);
    return picked === undefined ? undefined : { value: picked };
  }

  private async suggest(path: string[], key: string[], node: SchemaNode, current: unknown, suggestions: string[]): Promise<Edited> {
    const other = '@other';
    const picked = await this.app.choose<string>(path, node.description ?? '', [...suggestions.map((s) => ({ value: s, label: s })), { value: other, label: 'Other…', description: 'Type a name that is not in the list.' }], typeof current === 'string' ? current : undefined);
    if (picked === undefined) return undefined;
    if (picked !== other) return { value: picked };
    const typed = await this.app.text({ path, label: Text.humanize(key[key.length - 1]), initial: typeof current === 'string' ? current : '', validate: (v) => node.check(v) });
    return typed === undefined ? undefined : { value: typed };
  }

  private async json(path: string[], key: string[], node: SchemaNode, current: unknown): Promise<Edited> {
    const typed = await this.app.text({
      path, label: Text.humanize(key[key.length - 1]) + ' (JSON)', about: node.description ? [node.description] : [], initial: current === undefined ? '' : JSON.stringify(current),
      validate: (v) => { try { return node.check(JSON.parse(v)); } catch { return 'This is not valid JSON.'; } },
    });
    return typed === undefined ? undefined : { value: JSON.parse(typed) };
  }
}

// ---- collections -----------------------------------------------------------------------------------------------------

const SAVE = '@save';
const ADD = '@add';

/**
 * The shared shape of the list and map editors: a working copy shown as a list with "Save" and "Add" at the top, Enter
 * to change an entry, d to delete it. Esc with unsaved changes asks first.
 */
abstract class CollectionEditor<C> {
  protected value!: C;
  private original!: C;

  constructor(protected readonly app: App, protected readonly path: string[], protected readonly node: SchemaNode, protected readonly editor: ValueEditor) {}

  protected abstract entries(): ListItem<string>[];
  protected abstract add(): Promise<void>;
  protected abstract open(id: string): Promise<void>;
  protected abstract remove(id: string): void;
  protected move?(id: string, by: number): string | undefined;
  protected noun = 'entry';

  async run(start: C): Promise<Edited> {
    this.original = structuredClone(start);
    this.value = structuredClone(start);
    let focus: string | undefined;
    for (;;) {
      const dirty = !_.isEqual(this.value, this.original);
      const entries = this.entries();
      const picked = await this.app.list<string>({
        path: this.path,
        intro: this.node.description,
        items: [
          { value: SAVE, label: dirty ? Theme.ok(Theme.glyph.ok + ' Save changes') : Theme.muted(Theme.glyph.ok + ' Done (no changes)'), section: 'Actions' },
          { value: ADD, label: '+ Add ' + this.noun, section: 'Actions' },
          ...entries.map((e) => ({ ...e, section: entries.length + ' ' + this.noun + (entries.length === 1 ? '' : 's') })),
        ],
        startAt: focus,
        actions: [{ key: 'd', label: 'delete' }, ...(this.move ? [{ key: 'u', label: 'move up' }, { key: 'j', label: 'move down' }] : [])],
        empty: 'No ' + this.noun + 's yet.',
      });
      if (picked.kind === 'back') {
        if (!dirty || await this.app.confirm({ path: this.path, question: 'Discard your changes?', yes: 'Discard', no: 'Keep editing', initial: false, danger: true })) return undefined;
        continue;
      }
      if (picked.kind === 'pick' && picked.value === SAVE) return dirty ? { value: this.value } : undefined;
      if (picked.kind === 'pick' && picked.value === ADD) { await this.add(); continue; }
      const id = picked.kind === 'pick' || picked.kind === 'action' ? picked.value : undefined;
      if (id === undefined || id === SAVE || id === ADD) continue;
      focus = id;
      if (picked.kind === 'pick') await this.open(id);
      else if (picked.kind === 'action' && picked.key === 'd') this.remove(id);
      else if (picked.kind === 'action' && this.move) focus = this.move(id, picked.key === 'u' ? -1 : 1) ?? id;
    }
  }
}

/** A list of strings (project roots, scripts, extra packages ...). */
class StringListEditor extends CollectionEditor<string[]> {
  protected override noun = 'item';
  protected entries(): ListItem<string>[] { return this.value.map((v, i) => ({ value: String(i), label: v || Theme.muted('(empty)') })); }
  private async ask(initial: string): Promise<string | undefined> {
    const element = this.node.element!;
    return this.app.text({ path: this.path, label: 'Value', about: this.node.description ? [this.node.description] : [], initial, validate: (v) => element.check(v) });
  }
  protected async add(): Promise<void> { const v = await this.ask(''); if (v !== undefined) this.value.push(v); }
  protected async open(id: string): Promise<void> { const v = await this.ask(this.value[Number(id)]); if (v !== undefined) this.value[Number(id)] = v; }
  protected remove(id: string): void { this.value.splice(Number(id), 1); }
  protected override move(id: string, by: number): string {
    const from = Number(id);
    const to = Math.max(0, Math.min(this.value.length - 1, from + by));
    const [item] = this.value.splice(from, 1);
    this.value.splice(to, 0, item);
    return String(to);
  }
}

/** A map of names to simple values (environment variables). */
class MapEditor extends CollectionEditor<Record<string, unknown>> {
  protected override noun = 'variable';
  protected entries(): ListItem<string>[] { return Object.entries(this.value).map(([k, v]) => ({ value: k, label: k, hint: formatValue(v) })); }
  protected async add(): Promise<void> {
    const name = await this.app.text({ path: this.path, label: 'Name', about: ['Letters, digits and _ only, e.g. NPM_CONFIG_REGISTRY.'], validate: (v) => (this.value[v] !== undefined ? 'That name is there already.' : /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? true : 'Letters, digits and _ only.') });
    if (name === undefined) return;
    const edited = await this.editor.edit([...this.path, name], [name], this.node.element!, this.node.element!.initial());
    if (edited) this.value[name] = edited.value;
  }
  protected async open(id: string): Promise<void> {
    const edited = await this.editor.edit([...this.path, id], [id], this.node.element!, this.value[id]);
    if (edited) this.value[id] = edited.value;
  }
  protected remove(id: string): void { delete this.value[id]; }
}

/** A list of objects (mapped folders). */
class ObjectListEditor extends CollectionEditor<Record<string, unknown>[]> {
  protected override noun = 'entry';
  protected entries(): ListItem<string>[] { return this.value.map((v, i) => ({ value: String(i), label: summary(v) })); }
  protected async add(): Promise<void> {
    const edited = await new ObjectEditor(this.app, [...this.path, 'New'], this.node.element!, this.editor).run(this.node.element!.initial() as Record<string, unknown>, true);
    if (edited) this.value.push(edited.value as Record<string, unknown>);
  }
  protected async open(id: string): Promise<void> {
    const edited = await new ObjectEditor(this.app, [...this.path, summary(this.value[Number(id)])], this.node.element!, this.editor).run(this.value[Number(id)]);
    if (edited) this.value[Number(id)] = edited.value as Record<string, unknown>;
  }
  protected remove(id: string): void { this.value.splice(Number(id), 1); }
}

/** A map of names to objects (agents). */
class ObjectMapEditor extends CollectionEditor<Record<string, Record<string, unknown>>> {
  protected override noun = 'entry';
  protected entries(): ListItem<string>[] { return Object.entries(this.value).map(([k, v]) => ({ value: k, label: k, hint: Theme.muted(summary(v)) })); }
  protected async add(): Promise<void> {
    const name = await this.app.text({ path: this.path, label: 'Name', validate: (v) => (this.value[v] !== undefined ? 'That name is there already.' : /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v) ? true : 'Letters, digits, . _ and - only.') });
    if (name === undefined) return;
    const edited = await new ObjectEditor(this.app, [...this.path, name], this.node.element!, this.editor).run(this.node.element!.initial() as Record<string, unknown>, true);
    if (edited) this.value[name] = edited.value as Record<string, unknown>;
  }
  protected async open(id: string): Promise<void> {
    const edited = await new ObjectEditor(this.app, [...this.path, id], this.node.element!, this.editor).run(this.value[id]);
    if (edited) this.value[id] = edited.value as Record<string, unknown>;
  }
  protected remove(id: string): void { delete this.value[id]; }
}

/** One object as a form: each field with its value, Enter to change it, r to clear an optional one. */
export class ObjectEditor {
  constructor(private readonly app: App, private readonly path: string[], private readonly node: SchemaNode, private readonly editor: ValueEditor) {}

  async run(start: Record<string, unknown>, isNew = false): Promise<Edited> {
    const value = structuredClone(start);
    let focus: string | undefined;
    let notice: string | undefined;
    for (;;) {
      const dirty = isNew || !_.isEqual(value, start);
      const problem = this.node.check(value);
      const fields = this.node.children();
      const picked = await this.app.list<string>({
        path: this.path,
        intro: this.node.description,
        notice,
        items: [
          { value: SAVE, label: problem === true ? (dirty ? Theme.ok(Theme.glyph.ok + ' Save') : Theme.muted(Theme.glyph.ok + ' Done (no changes)')) : Theme.warn(Theme.glyph.cross + ' Not complete yet'), description: problem === true ? undefined : problem, section: 'Actions' },
          ...fields.map(([name, field]) => ({ value: name, label: Text.humanize(name), hint: formatValue(value[name]), description: field.description, section: 'Fields' })),
        ],
        startAt: focus,
        actions: [{ key: 'r', label: 'clear' }],
      });
      notice = undefined;
      if (picked.kind === 'back') {
        if (!dirty || await this.app.confirm({ path: this.path, question: 'Discard your changes?', yes: 'Discard', no: 'Keep editing', initial: false, danger: true })) return undefined;
        continue;
      }
      if (picked.kind === 'pick' && picked.value === SAVE) {
        if (problem !== true) { notice = Theme.warn(problem); continue; }
        return dirty ? { value } : undefined;
      }
      const name = picked.kind === 'pick' || picked.kind === 'action' ? picked.value : undefined;
      if (!name || name === SAVE) continue;
      focus = name;
      const field = this.node.child(name)!;
      if (picked.kind === 'action') { delete value[name]; continue; }
      const edited = await this.editor.edit([...this.path, Text.humanize(name)], [name], field, value[name]);
      if (edited) value[name] = edited.value;
    }
  }
}
