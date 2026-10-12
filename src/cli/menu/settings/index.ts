// The settings screen: every setting of your own config or this project's .sandbox-config.json, grouped into
// categories (sidebar), searchable, each with its value, default and description. Enter edits (on/off flips at once),
// r resets. Edits keep the file's comments and formatting, and nothing is saved unless the whole file stays valid.
import _ from 'lodash';
import { NEVER_LOOSER } from '../../../core/local-config.js';
import type { Config } from '../../../core/types.js';
import { App, Text, Theme, type Category, type ListItem } from '../../tui/index.js';
import { CATEGORIES, categoryOf, nameOf } from './categories.js';
import { ConfigFile } from './config-file.js';
import { formatValue, ValueEditor } from './editors.js';
import type { SchemaNode } from './schema-node.js';

export { CATEGORIES, nameOf } from './categories.js';
export { ConfigFile, editConfigText, fileValue, type SettingsTarget } from './config-file.js';
export { SchemaNode } from './schema-node.js';

interface Setting { key: string[]; node: SchemaNode; category: string; section?: string }

export class SettingsEditor {
  private readonly editor: ValueEditor;

  constructor(private readonly app: App, private readonly file: ConfigFile) {
    this.editor = new ValueEditor(app, { suggestions: (key) => (['defaultHarness', 'harness'].includes(key.join('.')) ? Object.keys(this.file.userConfig().harnesses) : undefined) });
  }

  private get title(): string { return this.file.isProject ? 'Project settings' : 'Your settings'; }

  /** Every editable setting with the category and heading it is shown under. */
  settings(): Setting[] {
    return this.file.schema.children().flatMap(([top, node]) => {
      const category = categoryOf(top);
      if (!category) return [];
      const several = category.keys.filter((k) => this.file.schema.child(k)).length > 1;
      if (!node.isSection) return [{ key: [top], node, category: category.id, section: several && category.id !== 'general' ? nameOf(top) : undefined }];
      return node.leaves([top]).map(({ key, node: leaf }) => {
        const heading = [several ? nameOf(top) : undefined, key.length > 2 ? key.slice(1, -1).map(nameOf).join(' › ') : undefined].filter(Boolean).join(' › ');
        return { key, node: leaf, category: category.id, section: heading || undefined };
      });
    });
  }

  private item(s: Setting, config: Config): ListItem<string> {
    const inFile = this.file.valueInFile(s.key);
    const set = inFile !== undefined;
    const now = this.file.effective(s.key, config);
    const yours = _.get(config, s.key);
    const value = this.file.isProject && !set ? Theme.muted('yours: ') + formatValue(yours, 40) : formatValue(now);
    const id = s.key.join('.');
    const details = [
      Theme.muted('Setting  ') + id,
      this.file.isProject
        ? (set ? Theme.changed('Set in this project') : Theme.muted('Not set in this project')) + Theme.muted(' · yours: ') + formatValue(yours, 30)
        : (set ? Theme.changed('Set in your file') : Theme.muted('Built-in default')) + Theme.muted(' · default: ') + formatValue(this.file.defaultOf(s.key), 30),
      ...(this.file.isProject && NEVER_LOOSER.includes(id) ? [Theme.warn(Theme.glyph.lock + ' A project can only make this stricter than your own setting.')] : []),
    ];
    return {
      value: id,
      label: Text.humanize(s.key[s.key.length - 1]),
      hint: set ? Theme.changed(Text.strip(value)) + ' ' + Theme.changed(Theme.glyph.changed) : value,
      description: s.node.description,
      details,
      section: s.section,
      category: s.category,
      keywords: id,
    };
  }

  async run(): Promise<void> {
    let focus: string | undefined;
    let notice: string | undefined;
    for (;;) {
      const config = this.file.userConfig();
      const settings = this.settings();
      const categories: Category[] = CATEGORIES.filter((c) => settings.some((s) => s.category === c.id)).map((c) => ({ id: c.id, label: c.label, description: c.description }));
      const picked = await this.app.list<string>({
        path: [this.title],
        status: Theme.muted('Editing ') + Text.middle(this.file.file, 80) + (this.file.exists ? '' : Theme.muted(' (created when you save)')),
        items: settings.map((s) => this.item(s, config)),
        categories,
        startAt: focus,
        actions: [{ key: 'r', label: this.file.isProject ? 'remove from project' : 'reset to default' }],
        notice,
      });
      notice = undefined;
      if (picked.kind === 'back') return;
      if (picked.kind !== 'pick' && picked.kind !== 'action') continue;
      if (picked.value === undefined) continue;
      focus = picked.value;
      const setting = settings.find((s) => s.key.join('.') === picked.value)!;
      if (picked.kind === 'action') notice = this.save(setting.key, undefined, 'reset');
      else notice = await this.edit(setting, config);
    }
  }

  private async edit(s: Setting, config: Config): Promise<string | undefined> {
    const current = this.file.isProject ? this.file.valueInFile(s.key) ?? _.get(config, s.key) : _.get(config, s.key);
    const path = [this.title, ...s.key.slice(0, -1).map(nameOf), Text.humanize(s.key[s.key.length - 1])];
    const edited = await this.editor.edit(path, s.key, s.node, current);
    return edited ? this.save(s.key, edited.value, 'save') : undefined;
  }

  /** Saves (or resets) one setting and returns the notice to show. */
  private save(key: string[], value: unknown, how: 'save' | 'reset'): string {
    const name = key.join('.');
    const result = this.file.set(key, value);
    if (result === 'unchanged') return Theme.muted(how === 'reset' ? name + ' is already the default.' : 'Unchanged.');
    if (typeof result === 'object') return Theme.error(Theme.glyph.cross + ' Not saved: ' + result.problems.join('; '));
    // The approval is tied to the file's exact contents, so any change makes the project file need approval again.
    const after = this.file.isProject ? ' The next launch asks you to approve the project file again.' : ' New sandboxes use it.';
    return Theme.ok(Theme.glyph.ok + ' ' + (how === 'reset' ? 'Reset ' + name + '.' : 'Saved ' + name + '.')) + Theme.muted(after);
  }
}
