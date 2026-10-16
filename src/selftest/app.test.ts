// The shared core: the kernel (definitions checked in and out, Fields from zod, questions and their fake, errors across
// a surface, the RPC messages), parity (every operation and query reachable on the CLI, the menu and the web, or
// exempt with a reason), the reference views' pages, their CLI and menu renderings, and the settings feature run
// against a config file of its own.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { agentsPage, agentsView } from '../app/features/agents/index.js';
import { DEFINITIONS, NAV, navSections, navViews, QUERIES, VIEWS, viewById } from '../app/features/defs.js';
import { accountsPage, agentPage, listAccounts, type AgentAccounts } from '../app/features/accounts/index.js';
import { addProject, projectRoots, projectsPage } from '../app/features/projects/index.js';
import { DEFAULTS } from '../core/config/index.js';
import { sandboxPage, type SandboxStatus } from '../app/features/sandbox/index.js';
import { sessionsPage, type SessionRow, type SessionsList } from '../app/features/sessions/index.js';
import { APP_GROUPS, appsPage, listApps, type AppsList } from '../app/features/apps/index.js';
import { settingsPage } from '../app/features/settings/index.js';
import type { AppContext } from '../app/context.js';
import {
  ago,
  Cancelled,
  ClientMessageSchema,
  defineOperation,
  exemption,
  fakeIO,
  fieldOf,
  fieldProblem,
  FieldSchema,
  fieldsOf,
  fromWireError,
  humanize,
  implementer,
  invoke,
  pageActions,
  ServerMessageSchema,
  SURFACE_NAMES,
  toWireError,
  valueText,
  type AnyDefinition,
  type Page,
  type SurfaceName,
  type AnyView,
} from '../app/kernel/index.js';
import { IMPLEMENTATIONS, readQuery, runDefinition } from '../app/registry.js';
import { parseCli } from '../cli/args.js';
import { COMMANDS, commandSpec } from '../cli/manifest.js';
import { menuView } from '../cli/menu/render-view.js';
import { MENU_VIEWS } from '../cli/menu/views.js';
import { cliInput, commandSpecOf, definitionFor } from '../cli/operations/index.js';
import { pageLines } from '../cli/output/index.js';
import { secret } from '../core/schema/index.js';
import { UserError } from '../core/util/index.js';
import type { Suite } from './support/suite.js';

const NOW = Date.now();

const running = (id: string, here: boolean): SessionRow => ({
  id,
  launchId: 'l1',
  harness: 'claude',
  cwd: 'C:\\Projects\\api',
  phase: 'running',
  message: 'running',
  updatedAt: new Date(NOW).toISOString(),
  startedAt: new Date(NOW - 5 * 60000).toISOString(),
  projectName: 'api',
  here,
  viewers: { viewers: 1, remote: 1 },
  canOpen: true,
});

const STATUS: SandboxStatus = {
  sandbox: {
    running: true,
    phase: 'ready',
    message: 'Ready',
    headless: true,
    startedAt: NOW - 3 * 3600000,
    daemon: 'pong (2 session(s) running)',
    account: 'work',
    syncWatcher: true,
  },
  here: { folder: 'C:\\Projects\\api', project: 'api', guest: 'C:\\Projects\\api' },
  roots: [{ host: 'C:\\Projects', guest: 'C:\\Projects' }],
  projects: [
    {
      name: 'api',
      host: 'C:\\Projects\\api',
      guest: 'C:\\Projects\\api',
      mechanism: 'launch',
      here: true,
      setup: { phase: 'ready', message: '' },
      databases: [{ database: 'postgres', port: 5432, state: 'running' }],
      sessions: [
        { id: 's1', harness: 'claude', viewers: '1 here, 0 in sandbox', started: new Date(NOW).toISOString() },
      ],
      repoGuard: [],
    },
  ],
  otherSessions: [],
  repoGuard: { guarded: 1, findings: ['hook: C:\\Projects\\api: .git/hooks/pre-commit'] },
};

/** The operations and queries a list of views can reach. */
function reached(views: readonly AnyView[]): Set<string> {
  return new Set(
    views.flatMap((v) => [
      ...v.operations.map((o) => o.id),
      ...Object.values(v.queries).map((q) => q.id),
      ...(v.pickers ?? []).map((q) => q.id),
    ]),
  );
}

/** Why a definition is not reachable on a surface ('' when it is). */
function gap(def: AnyDefinition, surface: SurfaceName, reach: Record<SurfaceName, Set<string>>): string {
  if (exemption(def, surface)?.trim()) return '';
  if (surface === 'cli') return def.cli ? '' : 'no CLI hint and no exemption';
  return reach[surface].has(def.id) ? '' : 'no ' + surface + ' view offers it and it declares no exemption';
}

export const appSuite: Suite = {
  name: 'app',
  title: 'shared core: kernel, parity of the three surfaces, reference views and their renderings, settings',
  run: async (t) => {
    t.section('definitions are checked going in and coming out');
    const implement = implementer<{ base: number }>();
    const add = defineOperation({
      id: 'test.add',
      title: 'Add',
      summary: 'adds',
      input: z.object({ n: z.number().int().describe('how many'), twice: z.boolean().default(false) }),
      output: z.object({ total: z.number() }),
      text: (o) => 'total ' + o.total,
    });
    const addRun = implement(add, (ctx, input) => ({ total: ctx.base + input.n * (input.twice ? 2 : 1) }));
    const io = fakeIO().io;
    t.equal(await invoke(addRun, { base: 1 }, { n: 2 }, io), { total: 3 }, 'defaults are filled in before run');
    await t.throws(() => invoke(addRun, { base: 1 }, { n: 'x' }, io), 'That does not work for add', 'a bad input');
    const broken = implement(add, () => ({ total: 'nope' }) as never);
    await t.throws(() => invoke(broken, { base: 0 }, { n: 1 }, io), 'expected number', 'an output that does not fit');

    t.section('questions, and the fake that answers them');
    const fake = fakeIO([true, 'too short', 'long enough']);
    const asked = await fake.io.confirm({ title: 'Sure?' });
    const typed = await fake.io.text({ title: 'Name', validate: (v) => (v.length > 9 ? true : 'Longer, please.') });
    fake.io.progress('working');
    fake.io.log('a line', 'muted');
    t.check(
      asked === true &&
        typed === 'long enough' &&
        fake.seen.questions.length === 3 &&
        fake.seen.questions[2].kind === 'text' &&
        'problem' in fake.seen.questions[2] &&
        fake.seen.questions[2].problem === 'Longer, please.' &&
        fake.seen.progress[0] === 'working' &&
        fake.seen.logs[0].tone === 'muted',
      'answers come in order, a typed answer is asked again with what was wrong, lines are recorded',
    );
    await t.throws(() => fakeIO().io.confirm({ title: 'Unplanned?' }), 'No answer for: Unplanned?', 'no answer left');

    t.section('errors cross a surface as message and fix');
    const user = toWireError(new UserError('It broke.', 'Do this.'));
    t.equal(user, { kind: 'user', message: 'It broke.', fix: 'Do this.' }, 'a UserError keeps its fix');
    t.equal(toWireError(new Cancelled()).kind, 'cancelled', 'a declined question is "cancelled"');
    t.equal(
      toWireError(new Error('C:\\secret')),
      { kind: 'bug', message: 'Something went wrong.' },
      'a bug says little',
    );
    t.equal(toWireError(z.number().safeParse('x').error).kind, 'invalid', 'a value that does not fit is "invalid"');
    const back = fromWireError(user);
    t.check(back instanceof UserError && back.fix === 'Do this.', 'and it becomes a UserError again on the other side');

    t.section('Fields from zod');
    const schema = z.object({
      on: z.boolean().default(true).describe('Switch it'),
      size: z.union([z.literal('auto'), z.number().int().min(1).max(64)]).describe('How big'),
      days: z.number().int().min(1).max(365).default(7),
      name: z.string().optional(),
      apiKey: secret(z.string()).default('hunter2'),
      cacheDir: z.string(),
      tags: z.array(z.string()),
      env: z.record(z.string(), secret(z.string())),
      mapping: z.object({ host: z.string(), readOnly: z.boolean().optional() }),
    });
    const fields = fieldsOf(schema);
    const kinds = Object.fromEntries(fields.map((f) => [f.name, f.kind]));
    t.equal(
      kinds,
      {
        on: 'boolean',
        size: 'enum',
        days: 'number',
        name: 'text',
        apiKey: 'secret',
        cacheDir: 'path',
        tags: 'list',
        env: 'map',
        mapping: 'object',
      },
      'every kind of value gets its kind of field',
    );
    const size = fields.find((f) => f.name === 'size')!;
    const days = fields.find((f) => f.name === 'days')!;
    const apiKey = fields.find((f) => f.name === 'apiKey')!;
    t.check(
      size.help === 'How big' &&
        size.choices?.[0]?.value === 'auto' &&
        size.open?.kind === 'number' &&
        days.range === '1 to 365' &&
        days.default === 7 &&
        days.optional &&
        apiKey.default === '***' &&
        fields.find((f) => f.name === 'cacheDir')?.pathKind === 'dir' &&
        fields.find((f) => f.name === 'mapping')?.fields?.length === 2 &&
        humanize('memoryMb') === 'Memory MB',
      'label, help, default, range, choices with a value of your own, folders, objects; a secret default never shows',
    );
    t.check(
      fields.every((f) => FieldSchema.safeParse(f).success) && FieldSchema.safeParse({ kind: 'x' }).success === false,
      'Fields are plain data that fits FieldSchema (what the browser receives)',
    );
    t.check(
      fieldProblem(days, 400) === 'Use 1 to 365.' &&
        fieldProblem(days, 3) === undefined &&
        fieldProblem(size, 'big') === undefined &&
        fieldProblem(fieldOf(z.enum(['a', 'b'])), 'c') === 'Choose one.' &&
        valueText('hunter2', apiKey).text === '***' &&
        valueText(true).text === 'On',
      'a Field checks a value as far as it can tell, and secrets read as ***',
    );

    t.section('the RPC messages');
    const good = [
      { t: 'call', id: 'c1', op: 'sessions.restart', input: { all: true } },
      { t: 'answer', id: 'c1', value: true },
      { t: 'subscribe', id: 's1', query: 'sandbox.status', input: {} },
      { t: 'unsubscribe', id: 's1' },
    ];
    const bad = [
      { t: 'call', id: 'c1', op: '../etc', input: {} },
      { t: 'call', id: 'with space', op: 'a.b', input: {} },
      { t: 'call', id: 'c1', op: 'a.b', input: {}, extra: 1 },
      { t: 'shell', id: 'c1' },
      'call',
    ];
    t.check(
      good.every((m) => ClientMessageSchema.safeParse(m).success) &&
        bad.every((m) => !ClientMessageSchema.safeParse(m).success) &&
        ServerMessageSchema.safeParse({ t: 'ask', id: 'c1', question: { kind: 'confirm', title: 'Go?' } }).success &&
        !ServerMessageSchema.safeParse({ t: 'ask', id: 'c1', question: { kind: 'shell', title: 'x' } }).success,
      'the browser may send only calls, answers and subscriptions of the right shape',
    );

    t.section('parity: every operation and query on every surface');
    const ids = DEFINITIONS.map((d) => d.id);
    const implemented = IMPLEMENTATIONS.map((i) => i.def.id);
    t.check(
      new Set(ids).size === ids.length &&
        ids.every((id) => implemented.includes(id)) &&
        implemented.every((id) => ids.includes(id)) &&
        IMPLEMENTATIONS.every((i) => DEFINITIONS.includes(i.def)),
      'every definition has exactly one implementation and every implementation is registered',
      ids.filter((id) => !implemented.includes(id)).join(', '),
    );
    const webViews = navViews(NAV).map((id) => viewById(id)!);
    const reach: Record<SurfaceName, Set<string>> = {
      cli: new Set(),
      menu: reached(MENU_VIEWS.map((m) => m.view)),
      web: reached(webViews),
    };
    const gaps = DEFINITIONS.flatMap((d) =>
      SURFACE_NAMES.map((s) => [d.id, s, gap(d, s, reach)] as const).filter(([, , why]) => why),
    ).map(([id, s, why]) => id + ' on ' + s + ': ' + why);
    t.equal(gaps, [], 'the parity list shows no gaps');
    t.check(
      VIEWS.every((v) => webViews.includes(v) || MENU_VIEWS.some((m) => m.view === v)) &&
        navSections(NAV).every((n) => n.view !== undefined || (n.children?.length ?? 0) > 0 || Boolean(n.elsewhere)),
      'every view is shown somewhere, and a web section without a view says where the area is',
    );
    const hinted = DEFINITIONS.filter((d) => d.cli);
    t.check(
      hinted.every((d) => {
        const names = [...(d.cli?.positional ?? []), ...Object.keys(d.cli?.flags ?? {})];
        const shape = (d.input as unknown as { shape?: Record<string, unknown> }).shape ?? {};
        return names.every((n) => n in shape);
      }) && hinted.filter((d) => !d.cli?.action).every((d) => commandSpecOf(d).name === d.cli?.name),
      'every CLI hint names fields of its input, and every command of its own has a group',
    );

    t.section('the commands keep their names and flags');
    const spec = (name: string): string =>
      JSON.stringify(
        commandSpec(name)?.options.map((o) => [o.flag, o.short ?? '', o.shownAs ?? '', o.type, o.description]),
      );
    t.check(
      ['status', 'sessions', 'restart', 'stop', 'show', 'hide'].every(
        (n) => COMMANDS.filter((c) => c.name === n).length === 1,
      ),
      'status, sessions, restart, stop, show and hide are commands (once each)',
    );
    t.equal(
      [spec('restart'), spec('stop'), spec('sessions')],
      [
        JSON.stringify([
          ['--harness', '', '--agent', 'string', 'only this agent'],
          ['--all', '', '', 'boolean', "every project's sessions, not only this folder's"],
        ]),
        JSON.stringify([['--yes', '-y', '', 'boolean', "do not ask when other projects' sessions would end"]]),
        JSON.stringify([['--wide', '', '', 'boolean', "also show each session's folder"]]),
      ],
      'with the flags and help they had',
    );
    const configChoices = commandSpec('config')?.args[0].choices;
    t.check(
      Array.isArray(configChoices) && ['get', 'set', 'reset', 'list'].every((a) => configChoices.includes(a)),
      'config get, set, reset and list are actions of config',
    );
    const restartLine = parseCli(['restart', '--agent', 'claude', '--all']);
    const setLine = parseCli(['config', 'set', 'sandbox.memoryMb', '8192']);
    t.equal(
      [cliInput(definitionFor('restart', [])!, restartLine), cliInput(definitionFor('config', ['set'])!, setLine)],
      [
        { harness: 'claude', all: true },
        { key: 'sandbox.memoryMb', value: '8192' },
      ],
      'a command line becomes the input (--agent and the old --harness, positional arguments after the action)',
    );
    t.check(
      definitionFor('config', ['show']) === undefined && definitionFor('config', []) === undefined,
      "config's own actions stay the command's",
    );

    t.section('the reference views');
    const statusPage = sandboxPage(STATUS);
    const stoppedPage = sandboxPage({ ...STATUS, sandbox: { ...STATUS.sandbox, running: false, phase: 'stopped' } });
    const limited = sandboxPage({
      ...STATUS,
      shared: { line: 'Running, started by bob (not shared)', limited: true, startedBy: 'bob' },
    });
    const ops = (page: Page): string[] => pageActions(page).flatMap((a) => (a.kind === 'operation' ? [a.op] : []));
    t.check(
      ops(statusPage).join() === 'sandbox.showWindow,sandbox.hideWindow,sandbox.stop' &&
        pageActions(statusPage).some((a) => a.kind === 'operation' && a.op === 'sandbox.stop' && a.danger) &&
        ops(stoppedPage).length === 0 &&
        limited.sections.length === 0 &&
        limited.notice?.text === 'Running, started by bob (not shared)',
      "status: the window and stop (marked dangerous) only while it runs; another user's unshared sandbox shows only whose it is",
    );
    const list: SessionsList = {
      sandboxRunning: true,
      defaultAgent: 'codex',
      wide: false,
      sessions: [running('old', false), { ...running('new', true), startedAt: new Date(NOW).toISOString() }],
    };
    const sessions = sessionsPage(list);
    const items = sessions.sections[0].items ?? [];
    t.check(
      items[0].id === 'new' &&
        items[0].primary?.kind === 'link' &&
        items[0].primary.target.kind === 'terminal' &&
        items[0].group === "This folder's project" &&
        ops(sessions).includes('sessions.restart') &&
        sessionsPage({ ...list, sessions: [] }).empty?.action?.kind === 'link',
      "sessions: this folder's project first, a running session opens its terminal, empty offers to start one",
    );
    for (const view of VIEWS as readonly AnyView[]) {
      const known = new Set(view.operations.map((o) => o.id));
      const sample = view.id === 'sandbox' ? statusPage : view.id === 'sessions' ? sessions : undefined;
      if (sample)
        t.check(
          ops(sample).every((op) => known.has(op)),
          view.id + ': the page offers only operations its view declares',
        );
    }

    t.section('agents');
    const agentsSample = agentsPage({
      folder: 'C:\\code\\api',
      defaultAgent: 'claude',
      agents: [
        { name: 'codex', ready: false, isDefault: false, removable: true },
        { name: 'claude', ready: true, isDefault: true, removable: false },
      ],
    });
    const agentItems = agentsSample.sections[0].items ?? [];
    const agentKeys = (id: string): string =>
      (agentItems.find((i) => i.id === id)?.actions ?? [])
        .flatMap((a) => (a.kind === 'operation' && a.key ? [a.key] : []))
        .join();
    t.check(
      agentItems.map((i) => i.id).join() === 'agent:claude,agent:codex,add' &&
        agentKeys('agent:claude') === '' &&
        agentKeys('agent:codex') === 'd,x' &&
        agentKeys('add') === '' &&
        agentItems[0].primary?.kind === 'link' &&
        ops(agentsSample).every((op) => agentsView.operations.some((o) => o.id === op)),
      "agents: the default first, Add last, d/x only where they apply; the page offers only its view's operations",
    );
    const agentIO = fakeIO().io;
    const noSandboxCtx = {} as unknown as AppContext;
    await t.throws(
      () => runDefinition('agents.start', noSandboxCtx, { agent: '../x' }, agentIO),
      'That does not work for start an agent',
      'agents.start refuses odd names',
    );
    await t.throws(
      () => runDefinition('agents.start', noSandboxCtx, { agent: 'claude' }, agentIO),
      'No Windows Sandbox is running.',
      'agents.start without a running sandbox says how to start one',
    );
    const agentsConfig = t.at('app-agents', 'config.json');
    t.write(agentsConfig, '{ "defaultHarness": "claude" }\n');
    const agentsCtx = { loaded: { configPath: agentsConfig } } as unknown as AppContext;
    await runDefinition('agents.add', agentsCtx, {}, fakeIO(['npm', 'mine', '@me/mine@latest', 'mine']).io);
    const before = fs.readFileSync(agentsConfig, 'utf8');
    await t.throws(
      () => runDefinition('agents.remove', agentsCtx, { name: 'mine' }, fakeIO([false]).io),
      'Nothing changed.',
      'agents.remove asks, and a no changes nothing',
    );
    t.check(fs.readFileSync(agentsConfig, 'utf8') === before, 'the config file is unchanged after a no');

    t.section('the CLI and the menu draw the same page');
    const sessionLines = pageLines(sessionsPage({ ...list, wide: true }));
    t.check(
      /^\s+ID\s+AGENT\s+PROJECT\s+STATE\s+ATTACHED\s+FOLDER\s+STARTED$/.test(sessionLines[0]) &&
        /^\*\s+new\s/.test(sessionLines[1]) &&
        sessionLines.includes('* = the project of this folder') &&
        !sessionLines.some((l) => l.includes('--wide')),
      'sessions on the command line: the table with the folder column (--wide), the marker and its note',
      sessionLines.join('\n'),
    );
    const statusLines = pageLines(statusPage);
    t.check(
      statusLines.some((l) => /^Running\s+yes$/.test(l)) &&
        statusLines.some((l) => /^Helper\s+responding, 2 sessions running$/.test(l)) &&
        statusLines.includes('* api  C:\\Projects\\api  ->  C:\\Projects\\api  (started from here)') &&
        statusLines.some((l) => l.startsWith('Repo guard  1 folder(s) guarded')),
      'status on the command line: facts as rows, projects with their details, the repo guard',
      statusLines.join('\n'),
    );
    t.equal(
      pageLines(sessionsPage({ ...list, sessions: [] })).at(-1),
      'No sessions. Start one with: sandbox claude',
      'an empty page prints its command-line text',
    );
    const menu = menuView(sessions);
    const chosen = menu.resolve({ kind: 'pick', value: 'new' });
    t.check(
      menu.items.length === 2 &&
        menu.actions.map((a) => a.key).join() === 'n,r,o,l' &&
        menu.enterLabel(undefined, 'new') === 'attach' &&
        chosen?.kind === 'action' &&
        chosen.action.kind === 'link' &&
        menu.resolve({ kind: 'action', key: 'l', value: undefined })?.kind === 'refresh',
      'sessions in the menu: rows, the n/r/o/l keys, Enter attaches',
    );
    const menuStatus = menuView(statusPage, { category: 'status', prefix: 'status:' });
    t.check(
      menuStatus.items.every((i) => i.category === 'status' && i.value.startsWith('status:')) &&
        menuStatus.actions.some((a) => a.key === 'x' && a.label === 'stop'),
      'a view inside one category of a page: rows in it, prefixed, with the keys of its actions',
    );

    t.section('settings, run against a config file');
    const configFile = t.writeJson(t.at('app-settings', 'config.json'), {
      storage: { root: t.dir('app-settings', 'storage') },
      harnesses: {
        planted: { npmPackage: 'p', npmBin: 'p', arguments: [], environment: { KEY: 'sk-planted-secret' } },
      },
    });
    const ctx = {
      loaded: { configPath: configFile },
      options: { workspace: t.dir('app-settings', 'project') },
      storageRoot: t.at('app-settings', 'storage'),
    } as unknown as AppContext;
    const quiet = fakeIO().io;
    const set = (await runDefinition('settings.set', ctx, { key: 'sandbox.memoryMb', value: '8192' }, quiet)) as {
      message: string;
    };
    const got = (await runDefinition('settings.get', ctx, { key: 'sandbox.memoryMb' }, quiet)) as { value: unknown };
    t.check(
      set.message === 'sandbox.memoryMb is 8192.' &&
        got.value === 8192 &&
        fs.readFileSync(configFile, 'utf8').includes('8192'),
      'set reads text like the command line, writes the file, and get reads it back',
      set.message,
    );
    await t.throws(
      () => runDefinition('settings.set', ctx, { key: 'sandbox.memoryMb', value: 'lots' }, quiet),
      'does not work for sandbox.memoryMb',
      'a value that does not fit is refused with what is allowed',
    );
    await t.throws(
      () => runDefinition('settings.set', ctx, { key: 'sandbox.memoryMbb', value: '1' }, quiet),
      'Did you mean sandbox.memoryMb',
      'a typo gets a suggestion',
    );
    const reset = (await runDefinition('settings.reset', ctx, { key: 'sandbox.memoryMb' }, quiet)) as {
      message: string;
    };
    t.check(
      reset.message.startsWith('sandbox.memoryMb is back to its default') &&
        !fs.readFileSync(configFile, 'utf8').includes('8192'),
      'reset removes the line',
    );

    t.section('the folder picker (files.browse)');
    const browseRoot = t.dir('app-browse');
    fs.mkdirSync(path.join(browseRoot, 'zeta'));
    fs.mkdirSync(path.join(browseRoot, 'Alpha'));
    fs.mkdirSync(path.join(browseRoot, '$Recycle.Bin'));
    fs.writeFileSync(path.join(browseRoot, 'notes.txt'), 'x');
    const folders = (await runDefinition('files.browse', ctx, { path: browseRoot }, quiet)) as {
      entries: { name: string; kind: string }[];
      parent: string | null;
    };
    t.equal(
      folders.entries.map((e) => e.name).join(),
      'Alpha,zeta',
      'a folder lists its folders by name, without files or $ system folders',
    );
    const withFiles = (await runDefinition('files.browse', ctx, { path: browseRoot, files: true }, quiet)) as {
      entries: { name: string; kind: string }[];
    };
    t.equal(
      withFiles.entries.map((e) => e.kind + ':' + e.name).join(),
      'dir:Alpha,dir:zeta,file:notes.txt',
      'with files: folders first, then files',
    );
    t.check(folders.parent === path.dirname(browseRoot), 'it names the folder above');
    await t.throws(
      () => runDefinition('files.browse', ctx, { path: 'relative\\folder' }, quiet),
      'is not a full path',
      'a path that is not a full path is refused',
    );
    const listed = await readQuery(
      QUERIES.find((q) => q.id === 'settings.list')!,
      ctx,
      { scope: 'user' },
    );
    const rows = (listed as { rows: { id: string; value: unknown; field: unknown }[] }).rows;
    const text = JSON.stringify(listed);
    t.check(
      rows.length > 50 &&
        !text.includes('sk-planted-secret') &&
        text.includes('***') &&
        !rows.some((r) => r.id === 'storage.root') &&
        rows.every((r) => FieldSchema.safeParse(r.field).success),
      'the rows: every setting with a Field, secrets as ***, the data folder through its own row',
    );
    const page = settingsPage(listed as Parameters<typeof settingsPage>[0]);
    const edit = page.sections.flatMap((s) => s.items ?? []).find((i) => i.id === 'sandbox.memoryMb')?.primary;
    t.check(
      page.sections.length >= 5 &&
        edit?.kind === 'operation' &&
        edit.op === 'settings.set' &&
        edit.fields?.[0]?.name === 'value' &&
        page.sections.some((s) => s.items?.some((i) => i.id === '@data-folder')),
      'the settings page: a section per category, each setting edited through its Field',
    );
    t.section('apps, run against a config file');
    const appsConfig = t.writeJson(t.at('app-apps', 'config.json'), {
      storage: { root: t.dir('app-apps', 'storage') },
    });
    const appsCtx = {
      loaded: { configPath: appsConfig },
      options: { workspace: t.dir('app-apps', 'project') },
      storageRoot: t.at('app-apps', 'storage'),
      dataPath: t.dir('app-apps', 'data'),
    } as unknown as AppContext;
    await runDefinition('apps.toggle', appsCtx, { id: 'lazygit', on: true }, quiet);
    const onText = fs.readFileSync(appsConfig, 'utf8');
    await runDefinition('apps.toggle', appsCtx, { id: 'lazygit', on: false }, quiet);
    const offText = fs.readFileSync(appsConfig, 'utf8');
    t.check(
      onText.includes('"lazygit"') && !offText.includes('"lazygit"'),
      'apps: turning an app on writes apps.install, off removes it',
    );
    await t.throws(
      () => runDefinition('apps.toggle', appsCtx, { scope: 'project', id: 'vscode', on: false }, quiet),
      'is not an app this scope can change',
      'apps: a project cannot change VS Code',
    );
    const dataDir = t.dir('app-apps', 'data');
    fs.mkdirSync(path.join(dataDir, 'tools', 'apps', 'lazygit'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'tools', 'apps', 'lazygit', '.agent-sandbox-app'), 'lazygit');
    const appsList = (await readQuery(listApps, appsCtx, { scope: 'user' })) as AppsList;
    const lazygit = appsList.apps.find((a) => a.id === 'lazygit');
    t.check(
      lazygit?.installed === true && appsList.apps.every((a) => APP_GROUPS.some((g) => g.id === a.group)),
      'apps: the list marks downloaded apps installed, and every row sits in a group',
    );
    const hand: AppsList = {
      scope: 'user',
      file: 'config.json',
      exists: true,
      apps: [
        {
          id: 'lazygit',
          name: 'lazygit',
          about: 'Git in a terminal',
          group: 'tools',
          size: '5 MB',
          cli: true,
          mesa: false,
          fullGitOnly: false,
          installed: true,
          on: true,
        },
      ],
      custom: [],
      customValue: {},
      customField: { name: 'custom', key: ['apps', 'custom'], kind: 'map', label: 'Your own programs', optional: true },
    };
    const userPage = appsPage(hand);
    const projectPage = appsPage({ ...hand, scope: 'project' });
    const actionsOf = (page: Parameters<typeof pageActions>[0]): string[] =>
      pageActions(page).flatMap((a) => (a.kind === 'operation' ? [a.op] : []));
    t.check(
      userPage.sections.some((s) => s.id === 'tools') &&
        actionsOf(userPage).includes('apps.setCustom') &&
        actionsOf(userPage).includes('apps.request') &&
        !actionsOf(projectPage).includes('apps.setCustom') &&
        !actionsOf(projectPage).includes('apps.request'),
      'apps: the page has a category per group; your own programs and the request only in your own scope',
    );

    t.equal(ago(NOW - 90 * 60000, NOW), '2 h ago', 'times read the same on every surface');

    t.section('accounts, run against a temp folder');
    const accCtx = {
      loaded: { config: structuredClone(DEFAULTS), configPath: null, base: t.temp },
      options: { workspace: t.dir('app-acc', 'project') },
      storageRoot: t.dir('app-acc', 'storage'),
      dataPath: t.dir('app-acc', 'data'),
    } as unknown as AppContext;
    t.write(t.at('app-acc', 'data', 'state', 'codex', 'auth.json'), '{"token":"A"}');
    const saving = fakeIO(['bad name', 'main']);
    const saved = (await runDefinition('accounts.save', accCtx, { agent: 'codex' }, saving.io)) as { message: string };
    t.check(
      saving.seen.questions[0]?.kind === 'text' &&
        saving.seen.questions.length === 2 &&
        saved.message === 'Saved account "main".',
      'accounts: save asks a name when none is given, and refuses a bad one',
      saved.message,
    );
    const listed2 = (await readQuery(listAccounts, accCtx, { agent: 'codex' })) as {
      agents: { name: string; accounts: { name: string }[] }[];
    };
    t.check(
      listed2.agents[0].name === 'claude' &&
        listed2.agents.find((a) => a.name === 'codex')?.accounts[0]?.name === 'main' &&
        JSON.stringify(listAccounts.cli?.shapeJson?.(listed2)) ===
          JSON.stringify(listed2.agents.find((a) => a.name === 'codex')?.accounts),
      'accounts: list shows Claude first and the saved codex login; --json keeps the rows of the one agent',
    );
    await t.throws(
      () => runDefinition('accounts.remove', accCtx, { agent: 'codex', name: 'main' }, fakeIO([false]).io),
      'Nothing removed.',
      'accounts: remove asks first; no is Nothing removed.',
    );
    const removed = (await runDefinition(
      'accounts.remove',
      accCtx,
      { agent: 'codex', name: 'main' },
      fakeIO([true]).io,
    )) as { message: string };
    t.equal(removed.message, 'Removed account main.', 'accounts: yes removes the login');
    const codex: AgentAccounts = {
      name: 'codex',
      kept: true,
      canSavePc: true,
      accounts: [{ name: 'main', email: null, isDefault: false, isActive: false, savedAt: '2026-10-12T08:00:00Z' }],
    };
    const codexMenu = menuView(agentPage(codex), { category: 'codex', refresh: false });
    t.check(
      codexMenu.enterLabel('codex', 'codex:main') === 'use' &&
        ['s', 'p', 'd', 'r', 'x'].every((k) => codexMenu.actions.some((a) => a.key === k)) &&
        accountsPage({ agent: 'codex', agents: [codex] }).sections[0].cards === true,
      'accounts: the page offers use on Enter and d/r/x on a login; the codex agent is a card',
    );
    const useDef = definitionFor('account', ['use'])!;
    t.check(
      JSON.stringify(cliInput(useDef, parseCli(['account', 'use', 'work', '--no-restart']))) ===
        JSON.stringify({ name: 'work', noRestart: true }) &&
        !('noRestart' in cliInput(useDef, parseCli(['account', 'use', 'work']))),
      'a --no- flag reaches the input (and is absent without it)',
    );

    t.section('projects, run against a temp folder');
    const projCfg = t.at('app-projects', 'config.json');
    t.write(projCfg, '{}\n');
    const projCtx = {
      loaded: { config: structuredClone(DEFAULTS), configPath: projCfg, base: t.temp },
      options: { workspace: t.dir('app-projects', 'here') },
      storageRoot: t.dir('app-projects', 'storage'),
      packageRoot: t.dir('app-projects', 'package'),
      dataPath: t.dir('app-projects', 'data'),
    } as unknown as AppContext;
    const projQuiet = fakeIO().io;
    const rootDir = t.dir('app-projects', 'roots', 'code');
    const addedRoot = (await runDefinition(
      'projects.roots',
      projCtx,
      { change: 'add', rootFolder: rootDir },
      projQuiet,
    )) as { message: string };
    t.check(
      addedRoot.message.startsWith('Added the project root ' + rootDir + ':'),
      'projects roots add: the folder becomes a root and the message says so',
      addedRoot.message,
    );
    const rootAgain = (await runDefinition(
      'projects.roots',
      projCtx,
      { change: 'add', rootFolder: rootDir },
      projQuiet,
    )) as { message: string };
    t.equal(rootAgain.message, rootDir + ' is a root already.', 'projects roots add: a root twice is said, not added');
    await t.throws(
      () => runDefinition('projects.roots', projCtx, { change: 'remove', rootFolder: rootDir }, fakeIO([false]).io),
      'Nothing changed.',
      'projects roots remove asks first; a no changes nothing',
    );
    t.check(fs.readFileSync(projCfg, 'utf8').includes('roots'), 'the root is still in the settings file after a no');
    const removedRoot = (await runDefinition(
      'projects.roots',
      projCtx,
      { change: 'remove', rootFolder: rootDir },
      fakeIO([true]).io,
    )) as { message: string };
    t.check(
      removedRoot.message.startsWith('Removed the project root ' + rootDir),
      'projects roots remove: yes removes it',
      removedRoot.message,
    );
    await t.throws(
      () => runDefinition('projects.roots', projCtx, { change: 'add', rootFolder: 'C:\\' }, projQuiet),
      'A whole drive cannot be a project root',
      'a whole drive cannot be a project root',
    );
    const projectDir = t.dir('app-projects', 'api');
    const addedProject = (await runDefinition('projects.add', projCtx, { projectFolder: projectDir }, projQuiet)) as {
      message: string;
      next?: string;
    };
    t.check(
      addedProject.message === 'Added ' + projectDir + ' to your projects.' &&
        addedProject.next === 'Next: sandbox projects all on   (map every project at every start)' &&
        (addProject.text?.(addedProject as never) ?? '').endsWith(addedProject.next ?? '~'),
      'projects add: says it was added, and what to do next while all projects is off (on the command line too)',
      addedProject.message,
    );
    await t.throws(
      () => runDefinition('projects.remove', projCtx, { projectFolder: projectDir }, fakeIO([false]).io),
      'Nothing changed.',
      'projects remove: a no is Nothing changed and keeps the project',
    );
    const allOn = (await runDefinition('projects.all', projCtx, { state: 'on' }, projQuiet)) as { message: string };
    t.check(
      allOn.message.startsWith('Mapping all projects at every start is on. This changes what is mapped'),
      'projects all on: the setting is written and the next start is said',
      allOn.message,
    );
    await t.throws(
      () => runDefinition('projects.choose', projCtx, {}, fakeIO([undefined]).io),
      'Nothing changed.',
      'projects choose: backing out changes nothing',
    );
    const projectsSample = projectsPage({
      all: false,
      roots: ['C:\\Projects'],
      exclude: [],
      projects: [
        {
          folder: 'C:\\Projects\\api',
          here: true,
          known: true,
          root: 'C:\\Projects',
          excluded: false,
          mappedAtStart: true,
          running: 'api (root)',
        },
        {
          folder: 'F:\\Code\\scratch',
          here: false,
          known: true,
          root: null,
          excluded: true,
          mappedAtStart: false,
          running: null,
        },
      ],
    });
    const projMenu = menuView(projectsSample, { category: 'projects', refresh: false });
    t.check(
      ['@add-root', 'root:C:\\Projects', 'project:C:\\Projects\\api', 'project:F:\\Code\\scratch'].every((v) =>
        projMenu.items.some((i) => i.value === v),
      ) &&
        projMenu.actions.map((a) => a.key).join() === 'a,f,f' &&
        projMenu.actions
          .filter((a) => a.key === 'f')
          .map((a) => a.label)
          .join() === 'remove root,forget project' &&
        projMenu.enterLabel(undefined, '@add-root') === 'choose folder' &&
        projMenu.resolve({ kind: 'action', key: 'a', value: undefined })?.kind === 'action',
      'projects in the menu: the row values (@add-root, root:, project:) and the keys a, f (root), f (project)',
      projMenu.actions.map((a) => a.key + ':' + a.label).join(' '),
    );
    const projLines = pageLines(projectsSample);
    t.check(
      projLines.some((l) => /^All projects\s+off$/.test(l)) &&
        projLines.some((l) => /FOLDER\s+AT START\s+RUNNING SANDBOX/.test(l)) &&
        projLines.includes('* = this folder.  Choose with: sandbox projects choose'),
      'projects list on the command line: the facts, the table and its note',
      projLines.join('\n'),
    );
    const rootFieldDef = fieldsOf(projectRoots.input).find((f) => f.name === 'rootFolder');
    const folderFieldDef = fieldsOf(addProject.input).find((f) => f.name === 'projectFolder');
    t.check(
      rootFieldDef?.kind === 'path' &&
        rootFieldDef.pathKind === 'dir' &&
        folderFieldDef?.kind === 'path' &&
        folderFieldDef.pathKind === 'dir',
      'the folder fields of projects are folder pickers',
    );
    const commandChoices = commandSpec('projects')?.args[0]?.choices ?? [];
    t.check(
      ['list', 'choose', 'add', 'remove', 'include', 'exclude', 'all', 'roots'].every((a) =>
        commandChoices.includes(a),
      ) &&
        definitionFor('projects', ['roots'])?.id === 'projects.roots' &&
        definitionFor('projects', []) === undefined,
      'the commands keep their names: projects takes the eight actions; roots is its own definition',
    );
  },
};
