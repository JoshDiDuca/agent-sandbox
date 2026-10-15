// Section 3: the sandbox as a whole. Status (the sandbox view: its facts, the window, stopping it), Projects (roots and
// known projects) and Databases (start and stop), each a category on the left.
import fs from 'node:fs';
import path from 'node:path';
import { sandboxPage, sandboxStatus, type SandboxStatus } from '../../../app/features/sandbox/index.js';
import { readQuery } from '../../../app/registry.js';
import { errMsg, safeText } from '../../../core/util/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import type { Context } from '../../commands/context.js';
import { DatabasesService, ProjectsService, type DatabaseRow, type ProjectsListing } from '../../services/index.js';
import {
  Text,
  Theme,
  type App,
  type ListAction,
  type ListItem,
  type ListOptions,
  type ListResult,
} from '../../tui/index.js';
import { MenuOperations } from '../io-menu.js';
import { menuView, type MenuView } from '../render-view.js';
import { ListPage, type Outcome } from './list-page.js';

export interface SandboxModel {
  readonly report: SandboxStatus;
  readonly projects: ProjectsListing;
  /** Null: the sandbox is not running or did not answer. */
  readonly databases: DatabaseRow[] | null;
  /** The agent "Start the sandbox" offers while nothing runs. */
  readonly defaultAgent: string;
}

const CATEGORIES = [
  { id: 'status', label: 'Status', description: 'What the sandbox is doing, its window, and stopping it.' },
  {
    id: 'projects',
    label: 'Projects',
    description: 'Project roots (folders of projects, opened without a restart) and the projects started before.',
  },
  { id: 'databases', label: 'Databases', description: 'Databases the sandbox can run: start and stop them.' },
];

/** The status category: the sandbox view's rows (prefixed, so they never clash with the projects' rows). */
function statusView(m: SandboxModel): MenuView {
  return menuView(sandboxPage(m.report), { category: 'status', prefix: 'status:', refresh: false });
}

/** The list for the sandbox tab. Pure. */
export function sandboxOptions(m: SandboxModel): ListOptions<string> {
  const running = m.report.sandbox.running;
  const status = statusView(m);
  const statusItems: ListItem<string>[] = [...(running ? [] : startRows(m.defaultAgent, 'status')), ...status.items];
  const addRoot: ListItem<string> = {
    value: ADD_ROOT,
    label: '+ Add a project root…',
    category: 'projects',
    section: 'Project roots',
    description: 'Pick a folder that holds your projects: every project in it (also new ones) opens without a restart.',
  };
  const roots: ListItem<string>[] = m.projects.roots.map((r) => ({
    value: 'root:' + r,
    label: Text.middle(r, 60),
    hint: Theme.muted('root'),
    category: 'projects',
    section: 'Project roots',
    description: 'Every project in this folder (also new ones) opens without a restart. f removes the root.',
  }));
  const projects: ListItem<string>[] = m.projects.projects.map((p) => ({
    value: 'project:' + p.folder,
    label: Text.middle(p.folder, 60),
    hint: p.running ?? (p.root ? 'in a root' : p.excluded ? 'excluded' : p.mappedAtStart ? 'mapped' : '-'),
    category: 'projects',
    section: 'Projects',
    description: p.here ? 'This is the folder you started the menu in.' : undefined,
    details: [
      Theme.muted('At start   ') + (p.root ? 'root' : p.excluded ? 'excluded' : p.mappedAtStart ? 'mapped' : '-'),
      Theme.muted('In sandbox ') + (p.running ?? '-'),
    ],
  }));
  const noDatabases: ListItem<string>[] = m.databases
    ? []
    : running
      ? [
          {
            value: 'info:db',
            label: 'The sandbox is not ready yet',
            category: 'databases',
            section: 'Databases',
            description: 'Its databases are listed once it is ready. l looks again.',
            disabled: 'Not ready yet: l looks again.',
          },
        ]
      : startRows(m.defaultAgent, 'databases');
  const databases: ListItem<string>[] = (m.databases ?? []).map((d) => ({
    value: 'db:' + d.name,
    label: d.name,
    hint: d.running ? Theme.ok('running') + Theme.muted(' :' + d.port) : Theme.muted('stopped :' + d.port),
    category: 'databases',
    section: 'Databases',
    description: d.title + '. Enter ' + (d.running ? 'stops' : 'starts') + ' it (the first start downloads it).',
  }));
  return {
    path: [],
    items: [...statusItems, addRoot, ...roots, ...projects, ...databases, ...noDatabases],
    categories: CATEGORIES,
    empty: 'Nothing here yet.',
    actions: (category) =>
      category === 'projects' || category === 'databases' ? sandboxActions(category) : [...status.actions, REFRESH],
    enterLabel: (category, id) => status.enterLabel(category, id) || enterLabel(id ?? '', m),
  };
}

const ADD_ROOT = '@add-root';
const REFRESH: ListAction<string> = { key: 'l', label: 'refresh', importance: 3 };

/** The rows that start a sandbox, shown where the sandbox has to run for anything to be there. */
function startRows(agent: string, category: string): ListItem<string>[] {
  return [
    {
      value: 'act:start',
      label: 'Start the sandbox with ' + agent,
      hint: Theme.muted('default agent'),
      category,
      section: 'No sandbox is running',
      description: 'Starts the sandbox and ' + agent + ' in this folder.',
    },
    {
      value: 'act:start-bare',
      label: 'Start the sandbox without an agent',
      category,
      section: 'No sandbox is running',
      description: 'Tools and databases only.',
    },
  ];
}

/** What Enter does on a row of Projects and Databases ("" = the row only shows information). */
function enterLabel(id: string, m: SandboxModel): string {
  if (id.startsWith('act:start')) return 'start';
  if (id === ADD_ROOT) return 'choose folder';
  if (id.startsWith('db:')) return m.databases?.find((d) => 'db:' + d.name === id)?.running ? 'stop' : 'start';
  return '';
}

function sandboxActions(category: 'projects' | 'databases'): ListAction<string>[] {
  if (category === 'projects')
    return [
      { key: 'a', label: 'add root', importance: 1 },
      { key: 'f', label: 'remove root', importance: 1, applies: (id) => id.startsWith('root:') },
      { key: 'f', label: 'forget project', importance: 1, applies: (id) => id.startsWith('project:') },
      REFRESH,
    ];
  return [REFRESH];
}

export class SandboxPage extends ListPage<string> {
  readonly label = 'Sandbox';
  private model: SandboxModel | undefined;
  private readonly projects: ProjectsService;
  private readonly operations: MenuOperations;

  constructor(
    app: App,
    private readonly ctx: Context,
  ) {
    super(app);
    this.projects = new ProjectsService(ctx);
    this.operations = new MenuOperations(app, ctx);
  }

  protected async load(): Promise<void> {
    const report = await readQuery(sandboxStatus, this.ctx);
    const guest = report.sandbox.running && report.sandbox.phase === 'ready' ? this.guestWorkspace() : null;
    let databases: DatabaseRow[] | null = null;
    if (guest) {
      try {
        databases = await new DatabasesService(this.ctx).list(guest);
      } catch {
        /* the sandbox did not answer: the list stays empty */
      }
    }
    this.model = { report, projects: this.projects.list(), databases, defaultAgent: this.defaultAgent() };
  }

  /** The folder `sbx-db` runs in: the sandbox's own workspace. */
  private guestWorkspace(): string | null {
    return new RunDir(this.ctx.dataPath).readSandboxStatus()?.guestWorkspace ?? null;
  }

  protected options(): ListOptions<string> {
    if (!this.model) throw new Error('The sandbox tab was not loaded');
    return sandboxOptions(this.model);
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    const id = result.kind === 'pick' || result.kind === 'action' ? result.value : undefined;
    const key = result.kind === 'action' ? result.key : undefined;
    try {
      if (key === 'l') return { reload: true };
      const chosen = this.model ? statusView(this.model).resolve(result) : undefined;
      if (chosen?.kind === 'action')
        return await this.operations.perform(chosen.action, [this.label], (text) => this.busy(text, id));
      if (id === 'act:start' && !key)
        return { exit: { kind: 'run', argv: ['launch', '--harness', this.defaultAgent()] } };
      if (id === 'act:start-bare' && !key) return { exit: { kind: 'run', argv: ['start'] } };
      if (id === ADD_ROOT && !key) return await this.addRoot();
      if (key === 'a') return await this.addRoot();
      if (key === 'f') return await this.forget(id);
      if (id?.startsWith('db:') && result.kind === 'pick') return await this.toggleDatabase(id.slice(3));
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
    return {};
  }

  private defaultAgent(): string {
    return this.ctx.loaded.config.defaultHarness;
  }

  private noSandbox(): Outcome<string> | null {
    return this.model?.report.sandbox.running ? null : { notice: Theme.warn('No sandbox is running.') };
  }

  private async addRoot(): Promise<Outcome<string>> {
    const picked = await this.app.pickPath({
      path: ['Sandbox', 'Add a project root'],
      title: 'Choose the folder that holds your projects',
      about: [
        'Every project inside it (also new ones) opens without a restart. Every agent in the sandbox can see them.',
      ],
      use: 'add this root',
      validate: (v) => (fs.existsSync(v) ? true : 'That folder does not exist.'),
    });
    if (!picked) return {};
    const { dir, added } = this.projects.addRoot(picked);
    return {
      reload: true,
      notice: added
        ? Theme.ok(Theme.glyph.ok + ' Added the root ' + dir + '.') + Theme.muted(' It applies from the next start.')
        : Theme.muted(dir + ' is a root already.'),
    };
  }

  private async forget(id: string | undefined): Promise<Outcome<string>> {
    const root = id?.startsWith('root:');
    if (!id || (!root && !id.startsWith('project:'))) return {};
    const folder = id.slice(root ? 5 : 8);
    const ok = await this.app.ask(
      (root ? 'Remove the root ' : 'Forget ') + path.basename(folder) + '?',
      [
        root
          ? 'Its projects are no longer opened without a restart.'
          : 'The project is dropped from your list of projects.',
        'Nothing in ' + folder + ' is touched.',
      ],
      root ? 'Remove' : 'Forget',
      true,
    );
    if (!ok) return {};
    if (id.startsWith('root:')) {
      const { dir, removed } = this.projects.removeRoot(id.slice(5));
      return {
        reload: true,
        notice: removed
          ? Theme.ok(Theme.glyph.ok + ' Removed the root ' + dir + '.')
          : Theme.muted(dir + ' was not a root.'),
      };
    }
    if (id?.startsWith('project:')) {
      const { dir, removed } = this.projects.forget(id.slice(8));
      return {
        reload: true,
        notice: removed
          ? Theme.ok(Theme.glyph.ok + ' Forgot ' + dir + '.') + Theme.muted(' Nothing in the folder was touched.')
          : Theme.muted(dir + ' was not in your projects.'),
      };
    }
    return {};
  }

  private async toggleDatabase(name: string): Promise<Outcome<string>> {
    const none = this.noSandbox();
    if (none) return none;
    const row = this.model?.databases?.find((d) => d.name === name);
    const guest = this.guestWorkspace();
    if (!row || !guest) return {};
    const action = row.running ? 'stop' : 'start';
    this.busy((row.running ? 'Stopping ' : 'Starting ') + name + '… the first start downloads it', 'db:' + name);
    const result = await new DatabasesService(this.ctx).run(action, name, guest);
    const last = safeText((result.stdout ?? '').trim().split(/\r?\n/).pop() ?? result.message);
    return {
      reload: true,
      notice: result.ok ? Theme.ok(Theme.glyph.ok + ' ' + last) : Theme.error(Theme.glyph.cross + ' ' + last),
    };
  }
}
