// Tab 5: every setting, for all projects or just this project (two scopes), grouped into categories on the left and
// searchable, with each value, its default and its description. Changes are staged in the Draft (marked *) and
// written with Ctrl+S; Enter edits, r resets to the default, z undoes an unsaved change.
import _ from 'lodash';
import { NEVER_LOOSER } from '../../../core/local-config/index.js';
import type { Config } from '../../../core/types.js';
import { errMsg } from '../../../core/util/index.js';
import {
  Text,
  Theme,
  type App,
  type Category,
  type ListItem,
  type ListOptions,
  type ListResult,
} from '../../tui/index.js';
import { CATEGORIES, categoryOf, nameOf } from '../settings/categories.js';
import type { ConfigFile } from '../settings/config-file.js';
import type { Draft } from '../settings/draft.js';
import { formatValue } from '../settings/format.js';
import type { SchemaNode } from '../settings/schema-node.js';
import { ValueEditor } from '../settings/value-editor.js';
import { SCOPES, scopeStatus, type Scope } from './scopes.js';
import { ListPage, type Outcome } from './list-page.js';

export interface Setting {
  readonly key: string[];
  readonly node: SchemaNode;
  readonly category: string;
  readonly section?: string;
}

/** Every editable setting with the category and heading it is shown under. */
export function settingsOf(file: ConfigFile): Setting[] {
  return file.schema.children().flatMap(([top, node]) => {
    const category = categoryOf(top);
    if (!category) return [];
    const several = category.keys.filter((k) => file.schema.child(k)).length > 1;
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

/** What the file will say for a setting once the staged changes are saved (undefined = not set there). */
function written(file: ConfigFile, draft: Draft, key: string[]): unknown {
  return draft.has(file, key) ? draft.value(file, key) : file.valueInFile(key);
}

/** What is in effect for a setting once the staged changes are saved. */
function effective(file: ConfigFile, draft: Draft, key: string[], config: Config): unknown {
  if (file.isProject) return written(file, draft, key);
  return draft.has(file, key) ? (draft.value(file, key) ?? file.defaultOf(key)) : _.get(config, key);
}

function item(
  s: Setting,
  files: Record<Scope, ConfigFile>,
  scope: Scope,
  draft: Draft,
  config: Config,
): ListItem<string> {
  const file = files[scope];
  const id = s.key.join('.');
  const set = written(file, draft, s.key) !== undefined;
  const unsaved = draft.has(file, s.key);
  const yours = effective(files.user, draft, s.key, config);
  const project = files.project;
  const inProject = project.schema.leaves().some((l) => l.key.join('.') === id)
    ? written(project, draft, s.key)
    : undefined;
  const paint = file.isProject ? Theme.project : Theme.changed;
  const value =
    file.isProject && !set
      ? Theme.muted('all projects: ') + formatValue(yours, 40)
      : formatValue(effective(file, draft, s.key, config));
  const details = [
    Theme.muted('Setting       ') + id,
    Theme.muted('All projects  ') +
      formatValue(yours, 40) +
      Theme.muted(written(files.user, draft, s.key) === undefined ? '  (built-in default)' : '  (your file)'),
    Theme.muted('This project  ') +
      (inProject === undefined ? Theme.muted('not set') : Theme.project(Text.strip(formatValue(inProject, 40)))),
    ...(!file.isProject ? [Theme.muted('Default       ') + formatValue(file.defaultOf(s.key), 40)] : []),
    ...(unsaved ? [Theme.warn('Unsaved: Ctrl+S saves, z undoes this change.')] : []),
    ...(file.isProject && NEVER_LOOSER.includes(id)
      ? [Theme.warn(Theme.glyph.lock + ' A project can only make this stricter than your own setting.')]
      : []),
  ];
  return {
    value: id,
    label: Text.humanize(s.key[s.key.length - 1]),
    hint: unsaved
      ? paint(Text.strip(value)) + ' ' + Theme.warn('*')
      : set
        ? paint(Text.strip(value)) + ' ' + paint(Theme.glyph.changed)
        : value,
    description: s.node.description,
    details,
    section: s.section,
    category: s.category,
    keywords: id,
  };
}

/** The list for the settings tab. Pure (reads the files it is given). */
export function settingsOptions(files: Record<Scope, ConfigFile>, scope: Scope, draft: Draft): ListOptions<string> {
  const file = files[scope];
  const config = file.userConfig();
  const settings = settingsOf(file);
  const categories: Category[] = CATEGORIES.filter((c) => settings.some((s) => s.category === c.id)).map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
  }));
  return {
    path: [],
    status: scopeStatus(file),
    tabs: { items: SCOPES.map((x) => x.tab), active: SCOPES.findIndex((x) => x.scope === scope) },
    items: settings.map((s) => item(s, files, scope, draft, config)),
    categories,
    actions: [
      { key: 'r', label: file.isProject ? 'remove from project' : 'reset to default' },
      { key: 'z', label: 'undo unsaved' },
    ],
    escapeLabel: 'quit',
  };
}

export class SettingsPage extends ListPage<string> {
  readonly label = 'Settings';
  override readonly stages = true;
  private scope: Scope = 'user';
  private readonly editor: ValueEditor;

  constructor(
    app: App,
    private readonly files: Record<Scope, ConfigFile>,
    private readonly draft: Draft,
  ) {
    super(app);
    this.editor = new ValueEditor(app, {
      suggestions: (key) =>
        ['defaultHarness', 'harness'].includes(key.join('.'))
          ? Object.keys(this.files.user.userConfig().harnesses)
          : undefined,
    });
  }

  private get file(): ConfigFile {
    return this.files[this.scope];
  }

  protected load(): Promise<void> {
    return Promise.resolve();
  }

  protected options(): ListOptions<string> {
    return settingsOptions(this.files, this.scope, this.draft);
  }

  /** Stages a value; your own file never keeps a line that only repeats the default. */
  private stage(key: string[], value: unknown): void {
    const file = this.file;
    if (
      !file.isProject &&
      value !== undefined &&
      _.isEqual(value, file.defaultOf(key)) &&
      file.valueInFile(key) === undefined
    )
      this.draft.unstage(file, key);
    else this.draft.stage(file, key, value);
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    if (result.kind === 'tab') {
      this.scope = SCOPES[result.index].scope;
      return {};
    }
    if (result.kind !== 'pick' && result.kind !== 'action') return {};
    if (result.value === undefined) return {};
    const setting = settingsOf(this.file).find((s) => s.key.join('.') === result.value);
    if (!setting) return {};
    if (result.kind === 'action') {
      if (result.key === 'z') {
        this.draft.unstage(this.file, setting.key);
        return {};
      }
      this.stage(setting.key, undefined);
      return {};
    }
    if (result.value === 'apps.install')
      return { notice: Theme.muted('Choose apps on the Apps tab (press 4); the list is picked there, not typed.') };
    try {
      const config = this.file.userConfig();
      const current = this.file.isProject
        ? (written(this.file, this.draft, setting.key) ?? _.get(config, setting.key))
        : effective(this.file, this.draft, setting.key, config);
      const path = [
        'Settings',
        ...setting.key.slice(0, -1).map(nameOf),
        Text.humanize(setting.key[setting.key.length - 1]),
      ];
      const edited = await this.editor.edit(path, setting.key, setting.node, current);
      if (edited) this.stage(setting.key, edited.value);
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
    return {};
  }
}
