// Tab 3: the sandbox as a whole. Status (a card, the window, stopping it), Projects (roots and known projects) and
// Databases (start and stop), each a category on the left.
import path from 'node:path';
import { errMsg, safeText } from '../../../core/util/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import type { Context } from '../../commands/context.js';
import { ago } from '../../output/index.js';
import {
  DatabasesService,
  ProjectsService,
  SandboxService,
  type DatabaseRow,
  type ProjectsListing,
  type SandboxReport,
} from '../../services/index.js';
import {
  Text,
  Theme,
  type App,
  type ListAction,
  type ListItem,
  type ListOptions,
  type ListResult,
} from '../../tui/index.js';
import { ListPage, type Outcome } from './list-page.js';

export interface SandboxModel {
  readonly report: SandboxReport;
  readonly projects: ProjectsListing;
  /** Null: the sandbox is not running or did not answer. */
  readonly databases: DatabaseRow[] | null;
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

const yesNo = (v: boolean | undefined): string => (v === undefined ? '-' : v ? 'yes' : 'no');

/** The list for the sandbox tab. Pure. */
export function sandboxOptions(m: SandboxModel): ListOptions<string> {
  const { sandbox, repoGuard } = m.report;
  const running = sandbox.running;
  const row = (id: string, label: string, hint: string, extra: Partial<ListItem<string>> = {}): ListItem<string> => ({
    value: id,
    label,
    hint,
    category: 'status',
    section: 'Sandbox',
    ...extra,
  });
  const off = running ? {} : { disabled: 'No sandbox is running.' };
  const sessions = m.report.projects.reduce((n, p) => n + p.sessions.length, 0) + m.report.otherSessions.length;
  const status: ListItem<string>[] = [
    row(
      'info:state',
      'State',
      running ? Theme.ok(Theme.glyph.on + ' ' + sandbox.phase) : Theme.muted(Theme.glyph.off + ' stopped'),
      { description: sandbox.message ? safeText(sandbox.message) : undefined },
    ),
    row('info:uptime', 'Up for', sandbox.startedAt && running ? ago(sandbox.startedAt).replace(' ago', '') : '-'),
    row('info:daemon', 'Sandbox agent', running ? safeText(sandbox.daemon) : '-'),
    row('info:window', 'Window', running ? (sandbox.headless ? 'hidden' : 'shown') : '-'),
    row('info:sessions', 'Sessions', running ? String(sessions) : '-'),
    row('info:account', 'Claude account', sandbox.account ?? '-'),
    row('info:sync', 'History sync running', yesNo(sandbox.syncWatcher)),
    row(
      'info:guard',
      'Repo guard',
      repoGuard.guarded +
        ' folder(s) guarded' +
        (repoGuard.findings.length ? ', ' + repoGuard.findings.length + ' change(s) neutralised' : ''),
      {
        details: repoGuard.findings.slice(-8).map((f) => Theme.warn(safeText(f))),
      },
    ),
    row('act:show', 'Show the window', '', {
      section: 'Actions',
      description: 'Brings the sandbox window to the front.',
      ...off,
    }),
    row('act:hide', 'Hide the window', '', {
      section: 'Actions',
      description: 'Hides the window; sbx-show inside the sandbox (or Show the window here) brings it back.',
      ...off,
    }),
    row('act:stop', 'Stop the sandbox…', '', {
      section: 'Actions',
      description: 'Shuts the sandbox down; history and claude-mem sync back when it closes.',
      ...off,
    }),
  ];
  const roots: ListItem<string>[] = m.projects.roots.map((r) => ({
    value: 'root:' + r,
    label: Text.middle(r, 60),
    hint: Theme.muted('root'),
    category: 'projects',
    section: 'Project roots',
    description: 'Every project in this folder (also new ones) opens without a restart.',
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
    items: [...status, ...roots, ...projects, ...databases],
    categories: CATEGORIES,
    empty: running ? 'Nothing here yet.' : 'No sandbox is running.',
    actions: sandboxActions,
    escapeLabel: 'quit',
  };
}

function sandboxActions(category: string | undefined): ListAction[] {
  if (category === 'projects')
    return [
      { key: 'a', label: 'add root' },
      { key: 'f', label: 'forget / remove' },
    ];
  return category === 'databases'
    ? []
    : [
        { key: 'w', label: 'show window' },
        { key: 'h', label: 'hide window' },
        { key: 'x', label: 'stop' },
      ];
}

export class SandboxPage extends ListPage<string> {
  readonly label = 'Sandbox';
  private model: SandboxModel | undefined;
  private readonly sandbox: SandboxService;
  private readonly projects: ProjectsService;

  constructor(
    app: App,
    private readonly ctx: Context,
  ) {
    super(app);
    this.sandbox = new SandboxService(ctx);
    this.projects = new ProjectsService(ctx);
  }

  protected async load(): Promise<void> {
    const report = await this.sandbox.status();
    const guest = report.sandbox.running && report.sandbox.phase === 'ready' ? this.guestWorkspace() : null;
    let databases: DatabaseRow[] | null = null;
    if (guest) {
      try {
        databases = await new DatabasesService(this.ctx).list(guest);
      } catch {
        /* the sandbox did not answer: the list stays empty */
      }
    }
    this.model = { report, projects: this.projects.list(), databases };
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
      if (id === 'act:show' || key === 'w') return this.show();
      if (id === 'act:hide' || key === 'h') return await this.hide();
      if (id === 'act:stop' || key === 'x') return await this.stop();
      if (key === 'a') return await this.addRoot();
      if (key === 'f') return this.forget(id);
      if (id?.startsWith('db:') && result.kind === 'pick') return await this.toggleDatabase(id.slice(3));
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
    return {};
  }

  private noSandbox(): Outcome<string> | null {
    return this.model?.report.sandbox.running ? null : { notice: Theme.warn('No sandbox is running.') };
  }

  private show(): Outcome<string> {
    const none = this.noSandbox();
    if (none) return none;
    this.sandbox.showWindow();
    return { notice: Theme.ok(Theme.glyph.ok + ' Window shown.') };
  }

  private async hide(): Promise<Outcome<string>> {
    const none = this.noSandbox();
    if (none) return none;
    await this.sandbox.hideWindow();
    return {
      reload: true,
      notice: Theme.ok(Theme.glyph.ok + ' Window hidden.') + Theme.muted(' sbx-show brings it back.'),
    };
  }

  private async stop(): Promise<Outcome<string>> {
    const none = this.noSandbox();
    if (none) return none;
    const plan = this.sandbox.stopPlan();
    const named = plan.running.map(
      (s) => safeText(s.harness) + ' in ' + safeText(s.project ?? path.win32.basename(s.cwd)),
    );
    const lines = [
      plan.running.length
        ? 'Stopping ends ' +
          plan.running.length +
          ' session' +
          (plan.running.length === 1 ? '' : 's') +
          ': ' +
          named.join(', ') +
          '.'
        : 'No session is running.',
      ...(plan.others.length ? [plan.others.length + ' of them belong to other projects.'] : []),
      'History and claude-mem sync back when it closes.',
    ];
    if (!(await this.app.ask('Stop the sandbox?', lines, 'Stop', true))) return {};
    await this.sandbox.shutdown(plan.sandbox);
    return { reload: true, notice: Theme.ok(Theme.glyph.ok + ' The sandbox is shutting down.') };
  }

  private async addRoot(): Promise<Outcome<string>> {
    const typed = await this.app.text({
      path: ['Sandbox', 'Add a project root'],
      label: 'Folder that holds your projects',
      about: [
        'Every project inside it (also new ones) opens without a restart. Every agent in the sandbox can see them.',
      ],
      validate: (v) => (v.trim() ? true : 'Type a folder.'),
    });
    if (!typed) return {};
    const { dir, added } = this.projects.addRoot(typed.trim());
    return {
      reload: true,
      notice: added
        ? Theme.ok(Theme.glyph.ok + ' Added the root ' + dir + '.') + Theme.muted(' It applies from the next start.')
        : Theme.muted(dir + ' is a root already.'),
    };
  }

  private forget(id: string | undefined): Outcome<string> {
    if (id?.startsWith('root:')) {
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
