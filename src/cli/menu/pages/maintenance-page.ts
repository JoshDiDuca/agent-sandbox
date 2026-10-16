// Section 7: keeping things in shape. Updates (the program and your saved settings), Data & storage (the data folder,
// what is stored, clean-up), Health (doctor, repair and this PC's setup together), the logs, and the less common
// commands. Each is a category on the left and loads when you open it.
import { dataPage, showData, type DataShow } from '../../../app/features/data/index.js';
import type { Action } from '../../../app/kernel/index.js';
import { readQuery } from '../../../app/registry.js';
import { userDir } from '../../../core/config/index.js';
import { errMsg } from '../../../core/util/index.js';
import { healthPage, lastHealth, type HealthLast } from '../../../app/features/health/index.js';
import {
  containedStatus,
  showStorage,
  storagePage,
  type ContainedStatus,
  type StorageShow,
} from '../../../app/features/storage/index.js';
import { CRASH, listLogs, logsPage, type LogFiles } from '../../../app/features/logs/index.js';
import type { Context } from '../../commands/context.js';
import { commandSpec, type CommandSpec } from '../../manifest.js';
import { MigrateService, NPM_UPDATE_COMMAND, UpdateService, type UpdateStatus } from '../../services/index.js';
import { describeResult } from '../../commands/maintenance/update.js';
import {
  Text,
  Theme,
  type App,
  type ListAction,
  type ListItem,
  type ListOptions,
  type ListResult,
} from '../../tui/index.js';
import { CommandForm } from '../command-form.js';
import { MenuOperations } from '../io-menu.js';
import { menuView, type MenuView } from '../render-view.js';
import { ListPage, type Outcome } from './list-page.js';

export interface MaintenanceModel {
  /** The Data & storage category's storage rows: the data folder and contained storage (null until read). */
  readonly storage: { readonly show: StorageShow; readonly contained: ContainedStatus } | null;
  /** Null until measured (measuring a big data folder takes a while). */
  readonly data: DataShow | null;
  /** The sandbox's logs (the logs view's query): the category's rows and its key. */
  readonly logs: LogFiles;
  /** The Health category: the last check or repair saved (null: none yet). */
  readonly health: { readonly last: HealthLast | null };
  /** The changes still to make to your saved settings (or why they cannot be read). */
  readonly settings: { readonly pending: readonly string[] } | { readonly error: string };
  /** The program's own updates: what is installed and what an update did. */
  readonly updates: UpdateStatus | { readonly error: string };
  /** A newer version found by "Check now" (null: not looked yet, or none). */
  readonly latest: string | null;
  /** The commands listed under "More commands". */
  readonly more: readonly { name: string; summary: string }[];
}

const CATEGORIES = [
  {
    id: 'updates',
    label: 'Updates',
    description: 'Which version is installed, installing a newer one, and bringing your saved settings up to date.',
  },
  {
    id: 'data',
    label: 'Data & storage',
    description: 'Where the sandbox keeps its data, what is stored, and deleting parts of it.',
  },
  {
    id: 'health',
    label: 'Health',
    description: 'Checks this PC and your settings, repairs problems, and sets up Windows Sandbox.',
  },
  { id: 'logs', label: 'Logs', description: "The sandbox's own logs." },
  { id: 'more', label: 'More commands', description: 'Less common commands.' },
];

const MORE_COMMANDS = ['sync', 'audit', 'config', 'generate', 'exec', 'agent-commands'];

const NO_LOGS: LogFiles = { folder: '', files: [], crash: false };

/** Plain names for the commands under More commands. */
const MORE_LABELS: Readonly<Record<string, string>> = {
  sync: 'Copy history back now',
  audit: 'What happened in the sandbox',
  config: 'Your settings file',
  generate: 'Preview a start',
  exec: 'Run a command in the sandbox',
  'agent-commands': 'Agent commands (Beta)',
};

/** The Data & storage category's rows and keys once measured: the data view (src/app/features/data) as menu rows. */
function dataMenuView(data: DataShow | null): MenuView | undefined {
  return data ? menuView(dataPage(data), { category: 'data', prefix: 'data:', refresh: false }) : undefined;
}

/** The storage view (the data folder, contained storage) as menu rows, drawn above the data rows. */
function storageMenu(s: MaintenanceModel['storage']): MenuView | undefined {
  return s
    ? menuView(storagePage(s.show, s.contained), { category: 'data', prefix: 'storage:', refresh: false })
    : undefined;
}

function dataItems(m: MaintenanceModel): ListItem<string>[] {
  const storage = storageMenu(m.storage)?.items ?? [];
  if (!m.data)
    return [
      ...storage,
      {
        value: 'data:measure',
        label: 'Measure what is stored',
        category: 'data',
        section: 'Stored data',
        description: 'Adds up the size of every folder. A big data folder takes a minute or more.',
      },
    ];
  return [...storage, ...(dataMenuView(m.data)?.items ?? [])];
}

function updateItems(m: MaintenanceModel): ListItem<string>[] {
  const row = (
    id: string,
    label: string,
    hint: string,
    description?: string,
    details?: string[],
  ): ListItem<string> => ({
    value: 'updates:' + id,
    label,
    category: 'updates',
    section: 'This program',
    hint,
    description,
    details,
  });
  if ('error' in m.updates) return [row('error', m.updates.error, '')];
  const u = m.updates;
  if (!u.managed)
    return [
      row('version', 'Version', u.version, 'Installed with npm, so npm updates it: ' + NPM_UPDATE_COMMAND),
      row('npm', 'Update', Theme.muted('with npm'), 'Run ' + NPM_UPDATE_COMMAND + ' in a terminal.'),
    ];
  const scope = u.scope === 'machine' ? 'for everyone on this PC' : 'for you';
  const rows = [
    row('version', 'Version', u.version, 'Installed ' + scope + '.'),
    row(
      'latest',
      'Newest version',
      m.latest ? Theme.warn(m.latest) : Theme.muted('not looked yet'),
      m.latest ? 'Enter installs it.' : 'Enter looks on GitHub for a newer version.',
    ),
    row(
      'auto',
      'Automatic updates',
      u.autoUpdate ? Theme.ok('on') : Theme.muted('off'),
      'Enter switches them. ' +
        (u.scope === 'machine'
          ? 'For everyone: needs an admin terminal.'
          : 'A new version installs when no sandbox runs.'),
    ),
  ];
  if (u.autoOffText)
    rows.push(row('autooff', 'Automatic updates turned off', Theme.warn('off'), u.autoOffText, [u.autoOffText]));
  if (u.state.previous) rows.push(row('previous', 'Previous version', u.state.previous, 'Enter goes back to it.'));
  if (u.state.failed)
    rows.push(
      row('failed', 'Last failed update', Theme.error(u.state.failed.version), u.state.failed.reason, [
        u.state.failed.reason,
        'It is not tried again until a newer version is released.',
      ]),
    );
  return rows;
}

/**
 * The logs view's rows and keys for the Logs category (its own empty row is left out: the category shows the page's
 * "Nothing here yet.").
 */
function logsMenu(files: LogFiles): MenuView {
  return menuView({ ...logsPage(files), empty: undefined }, { category: 'logs', refresh: false });
}

/** The list for the maintenance tab. Pure. */
export function maintenanceOptions(m: MaintenanceModel): ListOptions<string> {
  // The logs rows have no section heading of their own: the category is their heading.
  const logs: ListItem<string>[] = logsMenu(m.logs).items.map(({ section: _section, ...row }) => row);
  // The checks take seconds (programs are run), so they only run when you ask: the page shows the saved results.
  const health = healthMenu(m);
  const settings: ListItem<string>[] =
    'error' in m.settings
      ? [{ value: 'settings:error', label: m.settings.error, category: 'updates', section: 'Saved settings' }]
      : m.settings.pending.length
        ? m.settings.pending.map((line, i) => ({
            value: 'settings:' + i,
            label: line.split(':')[0],
            category: 'updates',
            section: 'Saved settings',
            hint: Theme.warn('to update'),
            description: 'Enter updates your saved settings (a backup is kept first).',
            details: [line],
          }))
        : [
            {
              value: 'settings:none',
              label: 'Up to date',
              category: 'updates',
              section: 'Saved settings',
              hint: Theme.ok('OK'),
              description: 'Nothing to update.',
            },
          ];
  const updates = updateItems(m);
  const more: ListItem<string>[] = m.more.map((c) => ({
    value: 'more:' + c.name,
    label: MORE_LABELS[c.name] ?? Text.humanize(c.name),
    category: 'more',
    description: c.summary.replace(/^./, (x) => x.toUpperCase()) + '.',
  }));
  return {
    path: [],
    categories: CATEGORIES,
    items: [...updates, ...settings, ...dataItems(m), ...health.items, ...logs, ...more],
    empty: 'Nothing here yet.',
    actions: maintenanceActions(m),
    enterLabel: (category, id) =>
      category === 'health'
        ? health.enterLabel(category, id)
        : (category === 'data'
            ? storageMenu(m.storage)?.enterLabel(category, id) || dataMenuView(m.data)?.enterLabel(category, id)
            : undefined) || enterLabel(id ?? '', m),
  };
}

/** The Health category: the health view's rows and keys, drawn only while that category is open. */
function healthMenu(m: MaintenanceModel): MenuView {
  return menuView(healthPage({ last: m.health.last }), { category: 'health', refresh: false });
}

/** What Enter does on a row ("" = the row only shows information). */
function enterLabel(id: string, m: MaintenanceModel): string {
  if (id === 'data:measure') return 'measure';
  if (id === 'updates:latest') return m.latest ? 'install' : 'look';
  if (id === 'updates:auto') return 'switch';
  if (id === 'updates:previous') return 'go back';
  if (id.startsWith('settings:') && id !== 'settings:none' && id !== 'settings:error') return 'update';
  if (id.startsWith('log:')) return 'show';
  if (id.startsWith('more:')) return 'open';
  return '';
}

function maintenanceActions(m: MaintenanceModel): (category: string | undefined) => ListAction<string>[] {
  return (category) => {
    switch (category) {
      case 'data':
        return [
          { key: 'm', label: 'measure again' },
          ...(storageMenu(m.storage)?.actions ?? []),
          ...(dataMenuView(m.data)?.actions ?? []),
        ];
      case 'logs':
        return logsMenu(m.logs).actions;
      case 'health':
        return healthMenu(m).actions;
      case 'updates': {
        const managed = !('error' in m.updates) && m.updates.managed;
        const previous = !('error' in m.updates) && Boolean(m.updates.state.previous);
        return [
          ...(managed
            ? [
                { key: 'c', label: 'check now' },
                { key: 'u', label: 'update now' },
                { key: 'a', label: 'automatic on/off', applies: (id: string) => id === 'updates:auto' },
                ...(previous
                  ? [{ key: 'r', label: 'roll back', applies: (id: string) => id === 'updates:previous' }]
                  : []),
              ]
            : []),
          ...('pending' in m.settings && m.settings.pending.length
            ? [
                {
                  key: 's',
                  label: 'update saved settings',
                  applies: (id: string) => id.startsWith('settings:') && id !== 'settings:none',
                },
              ]
            : []),
        ];
      }
      default:
        return [];
    }
  };
}

export class MaintenancePage extends ListPage<string> {
  readonly label = 'Maintenance';
  private data: DataShow | null = null;
  private storage: MaintenanceModel['storage'] = null;
  private logs: LogFiles = NO_LOGS;
  private last: HealthLast | null = null;
  private settings: MaintenanceModel['settings'] = { pending: [] };
  private readonly migrate: MigrateService;
  private readonly updateService: UpdateService;
  private readonly operations: MenuOperations;
  private latest: string | null = null;

  constructor(
    app: App,
    private readonly ctx: Context,
  ) {
    super(app);
    this.updateService = UpdateService.forPackage(ctx.packageRoot, undefined, { userDir: userDir() });
    this.operations = new MenuOperations(app, ctx);
    this.migrate = new MigrateService({
      storageRoot: ctx.storageRoot,
      userDir: userDir(),
      configPath: ctx.loaded.configPath,
    });
  }

  private model(): MaintenanceModel {
    return {
      storage: this.storage,
      data: this.data,
      logs: this.logs,
      health: { last: this.last },
      settings: this.settings,
      updates: this.updateStatus(),
      latest: this.latest,
      more: MORE_COMMANDS.flatMap((name) => {
        const spec = commandSpec(name);
        return spec ? [{ name, summary: spec.summary }] : [];
      }),
    };
  }

  protected async load(): Promise<void> {
    try {
      this.storage = {
        show: await readQuery(showStorage, this.ctx, { measure: false }),
        contained: await readQuery(containedStatus, this.ctx),
      };
    } catch {
      this.storage = null;
    }
    try {
      this.logs = await readQuery(listLogs, this.ctx);
    } catch {
      this.logs = NO_LOGS;
    }
    this.readSettings();
    this.last = (await readQuery(lastHealth, this.ctx)).last;
  }

  protected options(): ListOptions<string> {
    return maintenanceOptions(this.model());
  }

  private readSettings(): void {
    try {
      this.settings = { pending: this.migrate.plan() };
    } catch (e) {
      this.settings = { error: errMsg(e) };
    }
  }

  private updateStatus(): MaintenanceModel['updates'] {
    try {
      return this.updateService.status();
    } catch (e) {
      return { error: errMsg(e) };
    }
  }

  /** The Updates category: look, install, go back, switch automatic updates. */
  private async updates(key: string | undefined): Promise<Outcome<string>> {
    const service = this.updateService;
    if (!service.managed)
      return { notice: Theme.muted('Installed with npm: update it with ' + NPM_UPDATE_COMMAND + '.') };
    if (key === 'a') {
      const on = !service.status().autoUpdate;
      this.busy(on ? 'Turning automatic updates on…' : 'Turning automatic updates off…');
      service.setAuto(on);
      return { notice: Theme.ok(Theme.glyph.ok + ' Automatic updates are ' + (on ? 'on.' : 'off.')) };
    }
    if (key === 'r') {
      const target = service.status().state.previous;
      if (!target) return { notice: Theme.muted('There is no earlier version to go back to.') };
      if (
        !(await this.app.ask(
          'Go back to version ' + target + '?',
          ['Takes effect the next time you start it.'],
          'Go back',
        ))
      )
        return {};
      return { notice: Theme.ok(Theme.glyph.ok + ' Went back to version ' + service.rollback() + '.') };
    }
    if (key === 'c') {
      this.busy('Looking for a newer version…');
      const found = await service.check();
      this.latest = found.available && found.latest ? found.latest.version : null;
      return {
        notice: this.latest
          ? Theme.warn('Version ' + this.latest + ' is available.')
          : Theme.ok(Theme.glyph.ok + ' You have the newest version.'),
      };
    }
    if (key !== 'u') return {};
    this.busy('Installing the newest version…');
    const done = describeResult(await service.run(), false);
    this.latest = null;
    return {
      notice:
        done.code === 0 ? Theme.ok(Theme.glyph.ok + ' ' + done.line) : Theme.error(Theme.glyph.cross + ' ' + done.line),
    };
  }

  private async updateSettings(): Promise<Outcome<string>> {
    if (!('pending' in this.settings) || !this.settings.pending.length)
      return { notice: Theme.muted('Your saved settings are up to date.') };
    this.busy('Updating your saved settings…');
    const notes: string[] = [];
    const result = await this.migrate.run((line) => notes.push(line));
    this.readSettings();
    return {
      notice: result.postponed.length
        ? Theme.warn('Waiting until no sandbox runs: ' + result.postponed.join(', ') + '.')
        : Theme.ok(Theme.glyph.ok + ' Saved settings updated.'),
    };
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    const id = result.kind === 'pick' || result.kind === 'action' ? result.value : undefined;
    const key = result.kind === 'action' ? result.key : undefined;
    try {
      // The open category's rows and keys only (a key of one category must not fire in another).
      if (this.category === 'data') {
        const stored = storageMenu(this.storage)?.resolve(result);
        if (stored?.kind === 'action') return await this.dataAction(stored.action);
        const chosen = dataMenuView(this.data)?.resolve(result);
        if (chosen?.kind === 'action') return await this.dataAction(chosen.action);
      }
      if (key === 'm' || id === 'data:measure') return await this.measure();
      // Only the open category's rows and keys: `f` and Enter mean something else in Health.
      if (this.category === 'logs') {
        const chosen = logsMenu(this.logs).resolve(result);
        if (chosen?.kind === 'action') return this.showLog(chosen.action);
      }
      if ((result.kind === 'pick' && id?.startsWith('settings:')) || (key === 's' && this.category === 'updates'))
        return await this.updateSettings();
      if (this.category === 'updates') return await this.updates(key ?? this.updateKey(id));
      // Only the open category's rows and keys: a key of one category must not fire in another.
      if (this.category === 'health') {
        const chosen = healthMenu(this.model()).resolve(result);
        if (chosen?.kind === 'action')
          return await this.operations.perform(chosen.action, [this.label], (text) => this.busy(text));
        return {};
      }
      if (id?.startsWith('more:') && result.kind === 'pick') {
        const spec = commandSpec(id.slice(5)) as CommandSpec;
        const argv = await new CommandForm(this.app, this.ctx, spec).run();
        return argv ? { exit: { kind: 'run', argv } } : {};
      }
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
    return {};
  }

  /**
   * A Logs row or key: the crash report or the end of a log, on the normal screen (the menu's own view shows a log
   * there). Only names from the listing are looked up, never a path of their own.
   */
  private showLog(action: Action): Outcome<string> {
    if (action.kind !== 'link') return {};
    const target = action.target;
    if (target.kind === 'command') return { exit: { kind: 'run', argv: [...target.argv] } };
    if (target.kind !== 'view') return {};
    const name = target.params?.name;
    if (name === CRASH) return { exit: { kind: 'run', argv: ['logs', '--crash'] } };
    const file = this.logs.files.find((f) => f.name === name);
    return file ? { exit: { kind: 'view', file: file.path } } : {};
  }

  /** The key an Enter on an Updates row stands for. */
  private updateKey(id: string | undefined): string | undefined {
    if (id === 'updates:latest') return this.latest ? 'u' : 'c';
    if (id === 'updates:auto') return 'a';
    if (id === 'updates:previous') return 'r';
    return undefined;
  }

  private async measure(): Promise<Outcome<string>> {
    this.busy('Measuring what is stored… this can take a minute or more');
    this.data = await readQuery(showData, this.ctx);
    return { notice: Theme.ok(Theme.glyph.ok + ' Total stored: ' + this.data.total + '.') };
  }

  /**
   * Delete one stored folder, clean up, or change the data folder: the operation asks and reports as on the command
   * line. After it ran, the sizes shown are out of date, so the list goes back to "Measure what is stored" (a declined
   * question keeps it).
   */
  private async dataAction(action: Action): Promise<Outcome<string>> {
    const outcome = await this.operations.perform(action, [this.label], (text) => this.busy(text));
    if (outcome.reload) this.data = null;
    return outcome;
  }
}
