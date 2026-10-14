// Tab 7: keeping things in shape. What is stored (with clean-up), the logs, the doctor, repair, this PC's setup, and
// the less common commands. Each is a category on the left and loads when you open it.
import _ from 'lodash';
import type { DiskUsage } from '../../../core/disk.js';
import { humanBytes } from '../../../core/disk.js';
import { errMsg, fail } from '../../../core/util/index.js';
import type { Context } from '../../commands/context.js';
import { cleanTargetOf, type DataEntry } from '../../commands/data/collect.js';
import type { RepairResult, RepairStatus } from '../../commands/repair/types.js';
import { commandSpec, type CommandSpec } from '../../manifest.js';
import { ago } from '../../output/index.js';
import { DataService, HealthService, LogsService, type LogFile, type SetupReport } from '../../services/index.js';
import {
  Text,
  Theme,
  type App,
  type ListAction,
  type ListItem,
  type ListOptions,
  type ListResult,
} from '../../tui/index.js';
import type { Step } from '../../tui/index.js';
import { CommandForm } from '../command-form.js';
import type { ShellExit } from '../shell.js';
import { ListPage, type Outcome } from './list-page.js';

export interface MaintenanceModel {
  /** Null until measured (measuring a big data folder takes a while). */
  readonly data: { entries: DataEntry[]; disks: DiskUsage[]; total: number } | null;
  readonly logs: readonly LogFile[];
  readonly doctor: readonly (readonly string[])[] | null;
  readonly repair: readonly RepairResult[] | null;
  readonly setup: SetupReport | { error: string } | null;
  /** The commands listed under "More commands". */
  readonly more: readonly { name: string; summary: string }[];
}

const CATEGORIES = [
  { id: 'data', label: 'Stored data', description: 'What is kept between sandboxes, and deleting parts of it.' },
  { id: 'logs', label: 'Logs', description: "The sandbox's own logs." },
  { id: 'doctor', label: 'Doctor', description: 'Checks this PC and your settings.' },
  { id: 'repair', label: 'Repair', description: 'Finds common problems and fixes what it can.' },
  { id: 'setup', label: 'Set up this PC', description: 'Can this PC run Windows Sandbox?' },
  { id: 'more', label: 'More commands', description: 'Less common commands.' },
];

const MORE_COMMANDS = ['sync', 'audit', 'config', 'generate', 'exec', 'agent-commands'];

const REPAIR_LABEL: Record<RepairStatus, [string, (t: string) => string]> = {
  ok: ['OK', Theme.ok],
  fixed: ['FIXED', Theme.accent],
  'needs-you': ['NEEDS YOU', Theme.error],
  warn: ['WARNING', Theme.warn],
  skipped: ['SKIPPED', Theme.muted],
};

const AREA_LABEL: Record<DataEntry['area'], string> = {
  tools: 'Toolchains',
  databases: 'Databases',
  state: 'Agent state',
  logs: 'Logs',
  data: 'Other',
  host: 'On this PC',
};

function dataItems(m: MaintenanceModel): ListItem<string>[] {
  if (!m.data)
    return [
      {
        value: 'data:measure',
        label: 'Measure what is stored',
        category: 'data',
        hint: Theme.muted('press m'),
        description: 'Adds up the size of every folder. A big data folder takes a minute or more.',
      },
    ];
  return [
    ...m.data.disks.map((d) => ({
      value: 'disk:' + d.drive,
      label: d.drive,
      category: 'data',
      section: 'Disks',
      hint: humanBytes(d.usedBytes) + ' used · ' + humanBytes(d.freeBytes) + ' free of ' + humanBytes(d.totalBytes),
      description: d.holdsStorage ? 'The sandbox keeps its files on this drive.' : undefined,
    })),
    ...m.data.entries.map((e, i) => ({
      value: 'entry:' + i,
      label: e.name,
      category: 'data',
      section: AREA_LABEL[e.area],
      hint: humanBytes(e.bytes),
      description: cleanTargetOf(e) ? 'x deletes it.' : 'Kept on this PC on purpose; it is not deleted here.',
      details: [Theme.muted('Folder  ') + e.path],
    })),
  ];
}

/** The list for the maintenance tab. Pure. */
export function maintenanceOptions(m: MaintenanceModel): ListOptions<string> {
  const logs: ListItem<string>[] = m.logs.map((f) => ({
    value: 'log:' + f.name,
    label: f.name,
    category: 'logs',
    hint: humanBytes(f.bytes) + '  ' + ago(f.modified),
    description: 'Enter shows the end of this log in the terminal.',
  }));
  const doctor: ListItem<string>[] = (m.doctor ?? []).map(([name, detail], i) => ({
    value: 'doctor:' + i,
    label: name,
    category: 'doctor',
    hint: Text.truncate(detail, 50),
    details: [detail],
  }));
  const repair: ListItem<string>[] = m.repair
    ? m.repair.map((r, i) => {
        const [text, paint] = REPAIR_LABEL[r.status];
        return {
          value: 'repair:' + i,
          label: r.name,
          category: 'repair',
          hint: paint(text),
          description: r.detail,
        };
      })
    : [
        {
          value: 'repair:run',
          label: 'Run the checks and fix what can be fixed',
          category: 'repair',
          hint: Theme.muted('press f'),
          description: 'Each check confirms all is well, fixes the problem itself, or says what you need to do.',
        },
      ];
  const setup: ListItem<string>[] =
    m.setup === null
      ? []
      : 'error' in m.setup
        ? [{ value: 'setup:error', label: m.setup.error, category: 'setup' }]
        : m.setup.checks.map((c, i) => ({
            value: 'setup:' + i,
            label: c.name,
            category: 'setup',
            hint:
              c.status === 'ok'
                ? Theme.ok('OK')
                : c.status === 'warn'
                  ? Theme.warn('WARNING')
                  : Theme.error('ACTION NEEDED'),
            description: c.detail,
          }));
  const more: ListItem<string>[] = m.more.map((c) => ({
    value: 'more:' + c.name,
    label: Text.humanize(c.name),
    category: 'more',
    hint: Theme.muted('sandbox ' + c.name),
    description: c.summary.replace(/^./, (x) => x.toUpperCase()) + '.',
  }));
  return {
    path: [],
    categories: CATEGORIES,
    items: [...dataItems(m), ...logs, ...doctor, ...repair, ...setup, ...more],
    empty: 'Nothing here yet.',
    actions: maintenanceActions(m),
    escapeLabel: 'quit',
  };
}

function maintenanceActions(m: MaintenanceModel): (category: string | undefined) => ListAction[] {
  return (category) => {
    switch (category) {
      case 'data':
        return [{ key: 'm', label: 'measure' }, ...(m.data ? [{ key: 'x', label: 'delete' }] : [])];
      case 'logs':
        return [{ key: 'f', label: 'follow in the terminal' }];
      case 'doctor':
        return [{ key: 'l', label: 'check again' }];
      case 'repair':
        return [{ key: 'f', label: 'check and fix' }];
      case 'setup': {
        const canEnable = m.setup !== null && !('error' in m.setup) && m.setup.canEnable;
        return [
          { key: 'l', label: 'check again' },
          ...(canEnable ? [{ key: 'e', label: 'turn on Windows Sandbox' }] : []),
        ];
      }
      default:
        return [];
    }
  };
}

export class MaintenancePage extends ListPage<string> {
  readonly label = 'Maintenance';
  private data: MaintenanceModel['data'] = null;
  private logs: LogFile[] = [];
  private doctorRows: string[][] | null = null;
  private repairRows: RepairResult[] | null = null;
  private setupReport: MaintenanceModel['setup'] = null;
  private seen: string | undefined;
  private readonly health: HealthService;
  private readonly dataService: DataService;

  constructor(
    app: App,
    private readonly ctx: Context,
  ) {
    super(app);
    this.health = new HealthService(ctx);
    this.dataService = new DataService(ctx);
  }

  private model(): MaintenanceModel {
    return {
      data: this.data,
      logs: this.logs,
      doctor: this.doctorRows,
      repair: this.repairRows,
      setup: this.setupReport,
      more: MORE_COMMANDS.flatMap((name) => {
        const spec = commandSpec(name);
        return spec ? [{ name, summary: spec.summary }] : [];
      }),
    };
  }

  protected load(): Promise<void> {
    try {
      this.logs = new LogsService(this.ctx).files();
    } catch {
      this.logs = [];
    }
    return Promise.resolve();
  }

  protected options(): ListOptions<string> {
    return maintenanceOptions(this.model());
  }

  /** Opening a category loads what it shows (the cheap ones; data is measured on request). */
  protected override async afterKey(): Promise<Step<ShellExit>> {
    const category = this.category;
    if (category === this.seen) return;
    this.seen = category;
    if (category === 'doctor' && !this.doctorRows) await this.loadDoctor();
    else if (category === 'setup' && !this.setupReport) await this.loadSetup();
    else return;
    this.rebuild(undefined);
    return;
  }

  private async loadDoctor(): Promise<void> {
    this.busy('Checking this PC…');
    try {
      this.doctorRows = this.health.doctor();
    } catch (e) {
      this.doctorRows = [['Doctor', errMsg(e)]];
    }
  }

  private loadSetup(): Promise<void> {
    this.busy('Looking at this PC…');
    try {
      this.health.assertWindows();
      this.setupReport = this.health.setupReport();
    } catch (e) {
      this.setupReport = { error: errMsg(e) };
    }
    return Promise.resolve();
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    const id = result.kind === 'pick' || result.kind === 'action' ? result.value : undefined;
    const key = result.kind === 'action' ? result.key : undefined;
    try {
      if (key === 'm' || id === 'data:measure') return this.measure();
      if (key === 'x') return await this.remove(id);
      if (key === 'f' && this.category === 'logs') return { exit: { kind: 'run', argv: ['logs', '--follow'] } };
      if (id?.startsWith('log:') && result.kind === 'pick') {
        const file = this.logs.find((l) => l.name === id.slice(4));
        return file ? { exit: { kind: 'view', file: file.path } } : {};
      }
      if (key === 'f' || id === 'repair:run') return this.repair();
      if (key === 'l' && this.category === 'doctor') {
        await this.loadDoctor();
        return {};
      }
      if (key === 'l') {
        await this.loadSetup();
        return {};
      }
      if (key === 'e') return await this.enable();
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

  private measure(): Outcome<string> {
    this.busy('Measuring what is stored… this can take a minute or more');
    const report = this.dataService.report();
    this.data = { entries: report.entries, disks: report.disks, total: report.totalBytes };
    return { notice: Theme.ok(Theme.glyph.ok + ' Total stored: ' + humanBytes(report.totalBytes) + '.') };
  }

  private async remove(id: string | undefined): Promise<Outcome<string>> {
    const entry = id?.startsWith('entry:') ? this.data?.entries[Number(id.slice(6))] : undefined;
    if (!entry || !this.data) return {};
    const target =
      cleanTargetOf(entry) ?? fail('"' + entry.name + '" is kept on this PC on purpose.', 'It is not deleted here.');
    const plan = this.dataService.plan([target]);
    if (!plan.present.length) return { notice: Theme.muted(target + ' does not exist.') };
    const ok = await this.app.ask(
      'Delete ' + target + '?',
      [
        humanBytes(plan.totalBytes) + ' in ' + entry.path + '.',
        ...plan.present.flatMap((t) => (t.warning ? [t.target + ' ' + t.warning + '.'] : [])),
        'This cannot be undone.',
      ],
      'Delete',
      true,
    );
    if (!ok) return {};
    const outcome = this.dataService.clean(plan);
    if (outcome.failed.length)
      return { notice: Theme.error(Theme.glyph.cross + ' Could not remove everything: ' + outcome.failed.join('; ')) };
    const gone = this.data.entries.filter((e) => e !== entry);
    this.data = { ...this.data, entries: gone, total: _.sumBy(gone, 'bytes') };
    return { notice: Theme.ok(Theme.glyph.ok + ' Freed ' + humanBytes(outcome.freedBytes) + '.') };
  }

  private repair(): Outcome<string> {
    this.busy('Checking and fixing…');
    this.repairRows = this.health.repair();
    const needs = this.repairRows.filter((r) => r.status === 'needs-you').length;
    return {
      notice: needs
        ? Theme.warn(needs + ' thing(s) need you (see NEEDS YOU).')
        : Theme.ok(
            Theme.glyph.ok +
              ' All good' +
              (this.repairRows.some((r) => r.status === 'fixed') ? ': problems were fixed.' : '.'),
          ),
    };
  }

  private async enable(): Promise<Outcome<string>> {
    const ok = await this.app.ask(
      'Turn on Windows Sandbox?',
      ['Windows asks for admin permission, then you restart Windows to finish.'],
      'Turn on',
    );
    if (!ok) return {};
    // The admin prompt and its output need the normal screen.
    this.app.terminal.stop();
    const worked = this.health.enableFeature();
    this.app.terminal.start();
    await this.loadSetup();
    return {
      notice: worked
        ? Theme.ok(Theme.glyph.ok + ' Done. Restart Windows to finish.')
        : Theme.error(
            Theme.glyph.cross + ' Windows Sandbox could not be turned on (or the admin prompt was declined).',
          ),
    };
  }
}
