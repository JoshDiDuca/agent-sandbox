// The apps catalogue as data for the Apps tab: every app by category, ticked = installed in every sandbox. VS Code and
// Windows Terminal are listed too (they have settings of their own, which ticking changes). Ticks are staged in the
// Draft and written with Ctrl+S, to your config file or (catalogue apps only) the project's .sandbox-config.json.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { APPS, type AppCategory, type AppEntry } from '../../shared/apps/index.js';
import { Text, Theme, type Category, type ListItem } from '../tui/index.js';
import type { ConfigFile } from '../../app/features/settings/index.js';
import type { Draft } from './settings/draft.js';

export const CUSTOM = '@custom:';

/** The catalogue has many small categories; the menu shows these few groups so the navigation stays short. */
export const APP_GROUPS = [
  {
    id: 'editors',
    label: 'Editors & docs',
    description: 'Code and text editors (VS Code is on by default), plus diagrams and document conversion.',
    members: ['editors', 'diagrams'],
  },
  {
    id: 'clients',
    label: 'DB & API clients',
    description:
      'GUIs for the sandbox databases, tools to send HTTP, REST and GraphQL requests, and to inspect traffic.',
    members: ['databases', 'api', 'network'],
  },
  {
    id: 'tools',
    label: 'Git & utilities',
    description: 'Git GUIs and terminal UIs, archives, file search and comparing, process tools, and decompilers.',
    members: ['git', 'utilities', 'reversing'],
  },
  {
    id: 'cli',
    label: 'Command-line & cloud',
    description: 'Small developer tools (JSON, search, builds, media ...) and tools for clouds and Kubernetes.',
    members: ['cli', 'cloud'],
  },
  {
    id: 'play',
    label: 'Browsers & games',
    description: 'Browsers for testing web apps, and game engines and editors (they draw with OpenGL on the CPU).',
    members: ['browsers', 'gamedev'],
  },
] as const satisfies readonly { id: string; label: string; description: string; members: readonly AppCategory[] }[];

/** The group an app category is shown under. */
export function groupOf(category: AppCategory): string {
  return APP_GROUPS.find((g) => (g.members as readonly string[]).includes(category))?.id ?? 'tools';
}
const INSTALL = ['apps', 'install'];

/** The row in Apps that opens the "request an app" issue form (its id is not an app). */
export const REQUEST_APP = '@request-app';

/** This project's new-issue page on GitHub. */
export const ISSUES_URL = 'https://github.com/JoshDiDuca/windows-development-sandbox/issues/new';

/** The new-issue address with a title and a body to fill in (the page needs no login to show it). */
export function requestAppUrl(): string {
  const body = [
    '**App name:**',
    '',
    '**Where to get it** (GitHub releases page or a direct download link):',
    '',
    '**What it is for:**',
    '',
    '**Command-line tool or desktop app?**',
    '',
    '**Does it need a GPU, a license or an account?**',
  ].join('\n');
  const query = [
    ['title', 'App request: '],
    ['body', body],
    ['labels', 'app-request'],
  ];
  return ISSUES_URL + '?' + query.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

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
      ...APP_GROUPS.map(({ id, label, description }) => ({ id, label, description })),
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
      ...(entry.fullGitOnly
        ? [Theme.warn('Needs full git access (Settings > Projects & setup > Git): it pushes with its own git.')]
        : []),
      ...(entry.setting ? [Theme.muted('Setting   ') + entry.setting] : []),
    ];
    return {
      value: entry.id,
      label: entry.name,
      category: groupOf(entry.category),
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
      ...(this.file.isProject
        ? []
        : [
            {
              value: REQUEST_APP,
              label: 'Request an app…',
              category: 'custom',
              description:
                'Not in the list? Press r: your browser opens a prefilled request on GitHub (' + ISSUES_URL + ').',
              hint: Theme.muted('press r'),
              disabled: 'Press r to open the request form on GitHub.',
            },
          ]),
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

/** For notices: "12 apps chosen". */
export function appsSummary(file: ConfigFile): string {
  const config = file.userConfig();
  const n = config.apps.install.length + Object.keys(config.apps.custom).length;
  return n ? n + ' chosen' : 'none chosen';
}

export function appLabel(id: string): string {
  return APPS.find((a) => a.id === id)?.name ?? Text.humanize(id);
}
