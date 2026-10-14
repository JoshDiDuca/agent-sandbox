// The apps catalogue as data for the Apps tab: every app by category, ticked = installed in every sandbox. VS Code and
// Windows Terminal are listed too (they have settings of their own, which ticking changes). Ticks are staged in the
// Draft and written with Ctrl+S, to your config file or (catalogue apps only) the project's .sandbox-config.json.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { APP_CATEGORIES, APPS, type AppEntry } from '../../shared/apps/index.js';
import { Text, Theme, type Category, type ListItem } from '../tui/index.js';
import type { ConfigFile } from './settings/config-file.js';
import type { Draft } from './settings/draft.js';

export const CUSTOM = '@custom:';
const INSTALL = ['apps', 'install'];

export class AppsModel {
  constructor(
    private readonly file: ConfigFile,
    private readonly dataPath: string,
  ) {}

  /** The catalogue entries this file can change (a project cannot change an app that has a setting of its own). */
  entries(): AppEntry[] {
    return APPS.filter((a) => !(this.file.isProject && a.setting));
  }

  categories(): Category[] {
    return [
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
    ];
  }

  /** Downloaded already (into this data folder), so the next sandbox starts it without a download. */
  private installed(entry: AppEntry): boolean {
    if (entry.id === 'vscode') return fs.existsSync(path.join(this.dataPath, 'tools', 'vscode', 'Code.exe'));
    if (entry.id === 'windows-terminal')
      return fs.existsSync(path.join(this.dataPath, 'tools', 'terminal', 'WindowsTerminal.exe'));
    return fs.existsSync(path.join(this.dataPath, 'tools', 'apps', entry.id, '.agent-sandbox-app'));
  }

  private savedInstall(): string[] {
    return (
      ((this.file.isProject ? this.file.valueInFile(INSTALL) : this.file.userConfig().apps.install) as
        string[] | undefined) ?? []
    );
  }

  /** Is the entry on in the saved file? */
  private savedOn(entry: AppEntry): boolean {
    return entry.setting
      ? _.get(this.file.userConfig(), entry.setting) === true
      : this.savedInstall().includes(entry.id);
  }

  /** Is the entry on once the staged changes are saved? */
  isOn(entry: AppEntry, draft: Draft): boolean {
    if (entry.setting) {
      const key = entry.setting.split('.');
      return draft.has(this.file, key) ? draft.value(this.file, key) === true : this.savedOn(entry);
    }
    const staged = draft.has(this.file, INSTALL)
      ? (draft.value(this.file, INSTALL) as string[] | undefined)
      : undefined;
    return draft.has(this.file, INSTALL) ? (staged ?? []).includes(entry.id) : this.savedOn(entry);
  }

  /** Your own programs (apps.custom), staged or saved. */
  custom(draft: Draft): Record<string, { name: string; github?: string; url?: string; cli?: boolean }> {
    if (this.file.isProject) return {};
    const key = ['apps', 'custom'];
    return (draft.has(this.file, key) ? draft.value(this.file, key) : this.file.userConfig().apps.custom) as Record<
      string,
      { name: string; github?: string; url?: string; cli?: boolean }
    >;
  }

  private item(entry: AppEntry, draft: Draft): ListItem<string> {
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
      checked: this.isOn(entry, draft),
    };
  }

  items(draft: Draft): ListItem<string>[] {
    return [
      ...this.entries().map((a) => this.item(a, draft)),
      ...Object.entries(this.custom(draft)).map(([id, a]) => ({
        value: CUSTOM + id,
        label: a.name,
        category: 'custom',
        description: a.github ? 'From the latest ' + a.github + ' release.' : 'From ' + a.url,
        hint: Theme.muted(a.cli ? 'command line' : 'desktop'),
        checked: true,
        disabled: 'Your own programs are always installed; c to change or remove them.',
      })),
    ];
  }

  /** Stages the ticks of the list: only what differs from the saved file is kept in the draft. */
  stageTicks(draft: Draft, ticked: readonly string[]): void {
    for (const entry of this.entries().filter((a) => a.setting)) {
      const key = entry.setting!.split('.');
      const on = ticked.includes(entry.id);
      if (on === this.savedOn(entry)) draft.unstage(this.file, key);
      else draft.stage(this.file, key, on);
    }
    const wanted = this.entries()
      .filter((a) => !a.setting && ticked.includes(a.id))
      .map((a) => a.id);
    if (_.isEqual([...wanted].sort(), [...this.savedInstall()].sort())) draft.unstage(this.file, INSTALL);
    else draft.stage(this.file, INSTALL, wanted.length || this.file.isProject ? wanted : undefined);
  }
}

/** For the Start tab and notices: "12 apps chosen". */
export function appsSummary(file: ConfigFile): string {
  const config = file.userConfig();
  const n = config.apps.install.length + Object.keys(config.apps.custom).length;
  return n ? n + ' chosen' : 'none chosen';
}

export function appLabel(id: string): string {
  return APPS.find((a) => a.id === id)?.name ?? Text.humanize(id);
}
