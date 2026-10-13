// The settings screen: two scopes on tabs, your own settings ("All projects", blue) and this folder's
// .sandbox-config.json ("This project", purple); Tab switches and keeps your place. Every setting is grouped into
// categories (sidebar), searchable, with its value in both scopes, its default and description. Enter edits (on/off
// flips at once), r resets. Edits keep the file's comments and formatting, and nothing is saved unless the whole file
// stays valid.
import _ from 'lodash';
import { NEVER_LOOSER } from '../../../core/local-config/index.js';
import type { Config } from '../../../core/types.js';
import { App, Text, Theme, type Category, type ListItem, type Tab } from '../../tui/index.js';
import { AppsCatalogue } from '../apps.js';
import { CATEGORIES, categoryOf, nameOf } from './categories.js';
import { ConfigFile } from './config-file.js';
import { formatValue, ValueEditor } from './editors.js';
import type { SchemaNode } from './schema-node.js';

export { CATEGORIES, nameOf } from './categories.js';
export { ConfigFile, editConfigText, fileValue, type SettingsTarget } from './config-file.js';
export { SchemaNode } from './schema-node.js';

interface Setting {
  key: string[];
  node: SchemaNode;
  category: string;
  section?: string;
}

export type Scope = 'user' | 'project';
const SCOPES: { scope: Scope; tab: Tab }[] = [
  { scope: 'user', tab: { label: 'All projects', badge: 'YOURS', paint: Theme.scopeGlobal } },
  { scope: 'project', tab: { label: 'This project', badge: 'PROJECT', paint: Theme.scopeProject } },
];

export class SettingsEditor {
  private readonly editor: ValueEditor;

  /** files: your config and this folder's project file; dataPath: where the apps catalogue looks for installed apps. */
  constructor(
    private readonly app: App,
    private readonly files: Record<Scope, ConfigFile>,
    private scope: Scope = 'user',
    private readonly dataPath = '',
  ) {
    this.editor = new ValueEditor(app, {
      suggestions: (key) =>
        ['defaultHarness', 'harness'].includes(key.join('.'))
          ? Object.keys(this.file.userConfig().harnesses)
          : undefined,
    });
  }

  /** The file the current tab edits. */
  get file(): ConfigFile {
    return this.files[this.scope];
  }
  private get title(): string {
    return 'Settings · ' + (this.file.isProject ? 'This project' : 'All projects');
  }

  /** Every editable setting with the category and heading it is shown under. */
  settings(): Setting[] {
    return this.file.schema.children().flatMap(([top, node]) => {
      const category = categoryOf(top);
      if (!category) return [];
      const several = category.keys.filter((k) => this.file.schema.child(k)).length > 1;
      if (!node.isSection)
        return [
          {
            key: [top],
            node,
            category: category.id,
            section: several && category.id !== 'general' ? nameOf(top) : undefined,
          },
        ];
      return node.leaves([top]).map(({ key, node: leaf }) => {
        const heading = [
          several ? nameOf(top) : undefined,
          key.length > 2 ? key.slice(1, -1).map(nameOf).join(' › ') : undefined,
        ]
          .filter(Boolean)
          .join(' › ');
        return { key, node: leaf, category: category.id, section: heading || undefined };
      });
    });
  }

  private item(s: Setting, config: Config): ListItem<string> {
    const inFile = this.file.valueInFile(s.key);
    const set = inFile !== undefined;
    const yours = _.get(config, s.key);
    const id = s.key.join('.');
    const project = this.files.project;
    const inProject = project.schema.leaves().some((l) => l.key.join('.') === id)
      ? project.valueInFile(s.key)
      : undefined;
    const paint = this.file.isProject ? Theme.project : Theme.changed;
    const value =
      this.file.isProject && !set
        ? Theme.muted('all projects: ') + formatValue(yours, 40)
        : formatValue(this.file.effective(s.key, config));
    const details = [
      Theme.muted('Setting       ') + id,
      Theme.muted('All projects  ') +
        formatValue(yours, 40) +
        Theme.muted(this.files.user.valueInFile(s.key) === undefined ? '  (built-in default)' : '  (your file)'),
      Theme.muted('This project  ') +
        (inProject === undefined ? Theme.muted('not set') : Theme.project(Text.strip(formatValue(inProject, 40)))),
      ...(!this.file.isProject ? [Theme.muted('Default       ') + formatValue(this.file.defaultOf(s.key), 40)] : []),
      ...(this.file.isProject && NEVER_LOOSER.includes(id)
        ? [Theme.warn(Theme.glyph.lock + ' A project can only make this stricter than your own setting.')]
        : []),
    ];
    return {
      value: id,
      label: Text.humanize(s.key[s.key.length - 1]),
      hint: set ? paint(Text.strip(value)) + ' ' + paint(Theme.glyph.changed) : value,
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
      const categories: Category[] = CATEGORIES.filter((c) => settings.some((s) => s.category === c.id)).map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description,
      }));
      const picked = await this.app.list<string>({
        path: [this.title],
        tabs: { items: SCOPES.map((x) => x.tab), active: SCOPES.findIndex((x) => x.scope === this.scope) },
        status:
          (this.file.isProject ? Theme.project('●') : Theme.accent('●')) +
          Theme.muted(' Editing ') +
          Text.middle(this.file.file, 80) +
          (this.file.exists ? '' : Theme.muted(' (created when you save)')) +
          (this.file.isProject
            ? Theme.muted('  · only what a project may set; needs your approval at the next launch')
            : ''),
        items: settings.map((s) => this.item(s, config)),
        categories,
        startAt: focus,
        actions: [{ key: 'r', label: this.file.isProject ? 'remove from project' : 'reset to default' }],
        notice,
      });
      notice = undefined;
      if (picked.kind === 'back') return;
      // The other tab, on the same setting when that scope has it.
      if (picked.kind === 'tab') {
        this.scope = SCOPES[picked.index].scope;
        continue;
      }
      if (picked.kind !== 'pick' && picked.kind !== 'action') continue;
      if (picked.value === undefined) continue;
      focus = picked.value;
      const setting = settings.find((s) => s.key.join('.') === picked.value)!;
      if (picked.kind === 'action') notice = this.save(setting.key, undefined, 'reset');
      else notice = await this.edit(setting, config);
    }
  }

  private async edit(s: Setting, config: Config): Promise<string | undefined> {
    // The apps list is picked from the catalogue (by category, with sizes), not typed.
    if (s.key.join('.') === 'apps.install') return new AppsCatalogue(this.app, this.file, this.dataPath).run();
    const current = this.file.isProject ? (this.file.valueInFile(s.key) ?? _.get(config, s.key)) : _.get(config, s.key);
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
    const after = this.file.isProject
      ? ' The next launch asks you to approve the project file again.'
      : ' New sandboxes use it.';
    return (
      Theme.ok(Theme.glyph.ok + ' ' + (how === 'reset' ? 'Reset ' + name + '.' : 'Saved ' + name + '.')) +
      Theme.muted(after)
    );
  }
}
