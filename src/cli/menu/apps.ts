// The apps catalogue in the menu: every app by category, searchable, ticked = installed in every sandbox. VS Code and
// Windows Terminal are listed too (they have settings of their own, which ticking changes). Your own programs
// (apps.custom) are edited as a list of small forms. Saved to your config file (or, for catalogue apps only, the
// project's .sandbox-config.json).
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { APP_CATEGORIES, APPS, type AppEntry } from '../../shared/apps.js';
import { App, Text, Theme, type ListItem } from '../tui/index.js';
import type { ConfigFile } from './settings/config-file.js';
import { ValueEditor } from './settings/editors.js';

const CUSTOM = '@custom';

export class AppsCatalogue {
  constructor(
    private readonly app: App,
    private readonly file: ConfigFile,
    private readonly dataPath: string,
  ) {}

  /** Downloaded already (into this data folder), so the next sandbox starts it without a download. */
  private installed(entry: AppEntry): boolean {
    if (entry.id === 'vscode') return fs.existsSync(path.join(this.dataPath, 'tools', 'vscode', 'Code.exe'));
    if (entry.id === 'windows-terminal')
      return fs.existsSync(path.join(this.dataPath, 'tools', 'terminal', 'WindowsTerminal.exe'));
    return fs.existsSync(path.join(this.dataPath, 'tools', 'apps', entry.id, '.agent-sandbox-app'));
  }

  /** Is this entry on now (its setting, or listed in apps.install)? */
  private chosen(entry: AppEntry, install: string[]): boolean {
    return entry.setting ? _.get(this.file.userConfig(), entry.setting) === true : install.includes(entry.id);
  }

  private item(entry: AppEntry, install: string[]): ListItem<string> {
    const notes = [
      Theme.muted('Download  ') +
        '~' +
        entry.size +
        ' once, kept in C:\\AgentData\\tools\\' +
        (entry.setting ? '' : 'apps\\') +
        entry.id,
      Theme.muted('Starts    ') +
        (entry.cli ? 'from a terminal (on PATH)' : 'from the desktop or Start > Sandbox apps'),
      ...(entry.needs?.includes('mesa')
        ? [Theme.muted('Graphics  ') + 'OpenGL on the CPU (Mesa) is added for it']
        : []),
      ...(entry.fullGitOnly ? [Theme.warn('Needs provisioning.git.access "full" (it pushes with its own git).')] : []),
      ...(entry.setting ? [Theme.muted('Setting   ') + entry.setting] : []),
    ];
    return {
      value: entry.id,
      label: entry.name,
      category: entry.category,
      description: entry.about,
      details: notes,
      keywords: entry.id,
      hint: (this.installed(entry) ? Theme.ok('installed ') : '') + Theme.muted(entry.size),
      checked: this.chosen(entry, install),
      ...(this.file.isProject && entry.setting
        ? { disabled: 'A project cannot change this; it is in your own settings.' }
        : {}),
    };
  }

  /** Shows the catalogue until you save (Enter) or leave it (Esc); returns the notice to show afterwards. */
  async run(): Promise<string | undefined> {
    for (;;) {
      const install =
        ((this.file.isProject ? this.file.valueInFile(['apps', 'install']) : this.file.userConfig().apps.install) as
          string[] | undefined) ?? [];
      const custom = this.file.isProject ? {} : this.file.userConfig().apps.custom;
      const entries = APPS.filter((a) => !(this.file.isProject && a.setting));
      const picked = await this.app.list<string>({
        path: [this.file.isProject ? 'Project settings' : 'Apps'],
        intro:
          'Tick the apps every sandbox should have (space), then Enter to save. Each is downloaded once and kept; c = your own programs.',
        multi: true,
        categories: [
          ...APP_CATEGORIES,
          ...(this.file.isProject
            ? []
            : [
                {
                  id: 'custom',
                  label: 'Your own programs',
                  description: 'Programs you added yourself (c to add or change them).',
                },
              ]),
        ],
        items: [
          ...entries.map((a) => this.item(a, install)),
          ...Object.entries(custom).map(([id, a]) => ({
            value: CUSTOM + id,
            label: a.name,
            category: 'custom',
            description: a.github ? 'From the latest ' + a.github + ' release.' : 'From ' + a.url,
            hint: Theme.muted(a.cli ? 'command line' : 'desktop'),
            checked: true,
            disabled: 'Your own programs are always installed; c to change or remove them.',
          })),
        ],
        actions: this.file.isProject ? [] : [{ key: 'c', label: 'your own programs' }],
      });
      if (picked.kind === 'back') return undefined;
      if (picked.kind === 'action') {
        const notice = await this.editCustom();
        if (notice) return notice;
        continue;
      }
      if (picked.kind !== 'multi') continue;
      return this.save(picked.values.filter((v) => !v.startsWith(CUSTOM)));
    }
  }

  private save(ids: string[]): string {
    const problems: string[] = [];
    let changed = 0;
    for (const entry of APPS.filter((a) => a.setting && !this.file.isProject)) {
      const on = ids.includes(entry.id);
      if (on === this.chosen(entry, [])) continue;
      const result = this.file.set(entry.setting!.split('.'), on);
      if (typeof result === 'object') problems.push(...result.problems);
      else if (result === 'saved') changed++;
    }
    const install = APPS.filter((a) => !a.setting && ids.includes(a.id)).map((a) => a.id);
    const result = this.file.set(['apps', 'install'], install.length || this.file.isProject ? install : undefined);
    if (typeof result === 'object') problems.push(...result.problems);
    else if (result === 'saved') changed++;
    if (problems.length) return Theme.error(Theme.glyph.cross + ' Not saved: ' + problems.join('; '));
    if (!changed) return Theme.muted('Apps unchanged.');
    return (
      Theme.ok(
        Theme.glyph.ok +
          ' Saved: ' +
          (install.length ? install.length + ' app' + (install.length === 1 ? '' : 's') : 'no apps') +
          '.',
      ) +
      Theme.muted(
        this.file.isProject
          ? ' The next launch asks you to approve the project file again.'
          : ' The next sandbox installs what it does not have yet.',
      )
    );
  }

  /** Your own programs: the apps.custom map, each entry a form (GitHub release or link, program, command line or not). */
  private async editCustom(): Promise<string | undefined> {
    const node = this.file.schema.child('apps')?.child('custom');
    if (!node) return undefined;
    const edited = await new ValueEditor(this.app).edit(
      ['Apps', 'Your own programs'],
      ['apps', 'custom'],
      node,
      this.file.userConfig().apps.custom,
    );
    if (!edited) return undefined;
    const result = this.file.set(['apps', 'custom'], edited.value);
    if (typeof result === 'object') return Theme.error(Theme.glyph.cross + ' Not saved: ' + result.problems.join('; '));
    return result === 'saved'
      ? Theme.ok(Theme.glyph.ok + ' Saved your programs (' + Object.keys(edited.value as object).length + ').')
      : undefined;
  }
}

/** For the home screen: "12 apps chosen". */
export const appsSummary = (file: ConfigFile): string => {
  const config = file.userConfig();
  const n = config.apps.install.length + Object.keys(config.apps.custom).length;
  return n ? n + ' chosen' : 'none chosen';
};

export const appLabel = (id: string): string => APPS.find((a) => a.id === id)?.name ?? Text.humanize(id);
