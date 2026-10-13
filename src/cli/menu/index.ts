// The interactive menu (`sandbox` with no arguments): a full-screen app. The home screen groups everything into
// categories (start, sessions, sandbox, apps, settings ...); commands open as a form that shows the exact command line,
// which then runs like typing it. Settings and the project's .sandbox-config.json are edited in place.
import fs from 'node:fs';
import path from 'node:path';
import { errMsg, plainText } from '../../core/util.js';
import { loadConfig } from '../../core/config.js';
import { runningSessions } from '../../host/channel.js';
import { isSandboxRunning } from '../../host/platform.js';
import { syncAgentCommands } from '../commands/agent-commands.js';
import type { Context } from '../commands/context.js';
import { commandLine, readHistory } from '../history.js';
import { COMMANDS, commandSpec, type CommandSpecT } from '../manifest.js';
import { App, ExitRequested, Frame, Text, Theme, type Category, type ListItem } from '../tui/index.js';
import { AppsCatalogue, appsSummary } from './apps.js';
import { CommandForm } from './command-form.js';
import { ConfigFile, SettingsEditor } from './settings/index.js';
import { SeveralAgents } from './several.js';

export { optionProblem } from './command-form.js';
export { candidateFolders, severalAgentsArgv } from './several.js';

/** What a home entry does. */
type Action =
  | { kind: 'run'; argv: string[] }
  | { kind: 'form'; command: string; preset?: string[] }
  | { kind: 'several' }
  | { kind: 'settings'; target: 'user' | 'project' }
  | { kind: 'apps'; target: 'user' | 'project' };

const CATEGORIES: Category[] = [
  { id: 'start', label: 'Start', description: 'Start an agent (or several) in a sandbox, or a sandbox with only your tools.' },
  { id: 'sessions', label: 'Sessions', description: 'Agent sessions in the running sandbox: show one in this terminal, list them, restart them.' },
  { id: 'sandbox', label: 'Sandbox', description: 'The running sandbox: its status, window, databases, projects, and stopping it.' },
  { id: 'apps', label: 'Apps & tools', description: 'Desktop apps and command-line tools for every sandbox: editors, database clients, API clients, game engines, cloud CLIs ... and programs of your own.' },
  { id: 'settings', label: 'Settings', description: 'Every setting, for all projects or just this one, edited in place.' },
  { id: 'accounts', label: 'Claude accounts', description: 'Saved Claude logins: save one, switch, set the default.' },
  { id: 'data', label: 'Data & cleanup', description: 'What is kept between sandboxes (tools, databases, logins, logs), and deleting it.' },
  { id: 'health', label: 'Health & repair', description: 'Check this PC, find and fix problems, read the logs.' },
];

/** Readable names for commands on the home screen (the manifest's summaries are the descriptions). */
const TITLES: Record<string, string> = {
  start: 'Start a sandbox without an agent', 'host-claude': 'Claude on this PC (NOT sandboxed)', attach: 'Show a session in this terminal', sessions: 'List sessions',
  restart: 'Restart this project\'s agents', status: 'Sandbox status', db: 'Databases', exec: 'Run a command inside', stop: 'Stop the sandbox', projects: 'Projects',
  show: 'Show the sandbox window', hide: 'Hide the sandbox window', account: 'Claude accounts', data: 'Saved data', clean: 'Clean up old files', sync: 'Sync history now',
  logs: 'Logs', setup: 'Set up this PC', doctor: 'Doctor (check this PC)', repair: 'Repair', 'self-test': 'Self-test', generate: 'Preview a start (no sandbox)',
  config: 'Config file', 'agent-commands': 'Agent commands (Beta)', launch: 'Start an agent',
};
const CATEGORY_OF_GROUP: Record<string, string> = { Agents: 'start', Sandbox: 'sandbox', Sessions: 'sessions', Accounts: 'accounts', Data: 'data', Health: 'health', Config: 'settings' };

export class Menu {
  private readonly app = new App();
  private last: string | undefined;
  /** The result of the last action (saved apps ...), shown on the home screen once. */
  private notice: string | undefined;

  constructor(private readonly ctx: Context, private readonly runArgv: (argv: string[]) => Promise<number>) {
    this.app.status = () => this.status();
    try { Frame.version = (JSON.parse(fs.readFileSync(path.join(ctx.packageRoot, 'package.json'), 'utf8')) as { version?: string }).version ?? ''; } catch { /* no version shown */ }
  }

  private status(): string {
    const folder = Theme.muted(Text.middle(process.cwd(), 70));
    if (!isSandboxRunning()) return Theme.muted(Theme.glyph.off + ' No sandbox running') + '   ' + folder;
    const n = runningSessions(this.ctx.dataPath).length;
    return Theme.ok(Theme.glyph.on + ' Sandbox running') + Theme.muted(' · ' + n + ' session' + (n === 1 ? '' : 's')) + '   ' + folder;
  }

  /** Is this agent already in the sandbox's persistent storage (so starting it needs no install)? */
  private installed(name: string): boolean {
    const h = this.ctx.loaded.config.harnesses[name];
    const dir = path.join(this.ctx.dataPath, 'tools', 'agents', name);
    return Boolean(h) && [h.hostExecutable, h.npmBin && h.npmBin + '.cmd', h.uvBin && h.uvBin + '.exe'].some((f) => f && fs.existsSync(path.join(dir, f)));
  }

  private homeItems(): ListItem<string>[] {
    const config = this.ctx.loaded.config;
    const def = config.defaultHarness;
    const last = readHistory()[0];
    const items: ListItem<string>[] = [];
    const add = (category: string, section: string, label: string, action: Action, description?: string, hint?: string): void => { items.push({ value: JSON.stringify(action), label, category, section, description, hint }); };

    if (last) add('start', 'Quick start', 'Repeat last', { kind: 'run', argv: last.argv }, 'Runs the last command again.', Theme.muted(Text.truncate(commandLine(last.argv), 50)));
    add('start', 'Quick start', 'Start ' + def + ' in this folder', { kind: 'run', argv: ['launch', '--harness', def] }, 'Starts ' + def + ' in a sandbox for ' + process.cwd() + ' (or another session in the running sandbox).', this.installed(def) ? Theme.ok('ready') : Theme.muted('installs on first start'));
    add('start', 'Quick start', 'Start ' + def + ' with options…', { kind: 'form', command: 'launch', preset: ['--harness', def] }, 'Choose options first: attach this terminal, Node or Python version, databases, scripts ...');
    add('start', 'Quick start', 'Start several agents…', { kind: 'several' }, 'One or more projects, one or more agents each, all in one sandbox; attach to any of them.');
    for (const name of Object.keys(config.harnesses).filter((n) => n !== def)) add('start', 'Other agents', 'Start ' + name, { kind: 'form', command: 'launch', preset: ['--harness', name] }, 'Opens the start form for ' + name + '.', this.installed(name) ? Theme.ok('ready') : Theme.muted('installs on first start'));

    if (isSandboxRunning()) {
      for (const s of runningSessions(this.ctx.dataPath).slice(-12)) {
        add('sessions', 'Running now', plainText(s.harness) + ' · ' + plainText(path.win32.basename(s.cwd)), { kind: 'run', argv: ['attach', plainText(s.id)] }, 'Shows this session in this terminal (Ctrl+] detaches; the session keeps running).', Theme.muted(plainText(s.id)));
      }
    }
    const userFile = ConfigFile.user(this.ctx.loaded.configPath);
    add('apps', 'Apps', 'Browse the apps catalogue…', { kind: 'apps', target: 'user' }, 'Tick the apps every sandbox should have: by category, searchable, with sizes. Each downloads once and is kept.', Theme.muted(appsSummary(userFile)));
    add('apps', 'Apps', 'Apps for this project only…', { kind: 'apps', target: 'project' }, 'Catalogue apps this project needs (saved in its .sandbox-config.json, added to yours).');
    add('settings', 'Settings', 'Your settings', { kind: 'settings', target: 'user' }, 'Every setting, for all projects: languages, databases, the sandbox machine, agents, security ...');
    add('settings', 'Settings', 'This project\'s settings', { kind: 'settings', target: 'project' }, 'This folder\'s .sandbox-config.json: only what a project may set. A changed file needs your approval at the next launch.');

    for (const spec of COMMANDS.filter((s) => !s.hidden && s.name !== 'launch')) {
      const category = CATEGORY_OF_GROUP[spec.group];
      const section = category === 'start' ? 'More' : category === 'settings' ? 'Tools' : 'Commands';
      add(category, section, TITLES[spec.name] ?? Text.humanize(spec.name), { kind: 'form', command: spec.name }, spec.summary.replace(/^./, (c) => c.toUpperCase()) + '.', Theme.muted('sandbox ' + spec.name));
    }
    return items;
  }

  /** Runs the menu until you leave it, or until a command that takes over the terminal (launch, attach) has run. */
  async start(): Promise<number> {
    if (!process.stdin.isTTY) { console.log('The menu needs an interactive terminal. Run sandbox --help for the commands.'); return 1; }
    try {
      for (;;) {
        const picked = await this.app.list<string>({ path: [], items: this.homeItems(), categories: CATEGORIES, startAt: this.last, escapeLabel: 'quit', notice: this.notice });
        this.notice = undefined;
        if (picked.kind === 'back') return 0;
        if (picked.kind !== 'pick') continue;
        this.last = picked.value;
        const code = await this.perform(JSON.parse(picked.value) as Action);
        if (code !== undefined) return code;
      }
    } catch (e) {
      // Ctrl+C anywhere: leave quietly.
      if (e instanceof ExitRequested || (e instanceof Error && e.name === 'ExitPromptError')) return 130;
      throw e;
    } finally {
      this.app.close();
    }
  }

  private fileFor(target: 'user' | 'project'): ConfigFile { return target === 'user' ? ConfigFile.user(this.ctx.loaded.configPath) : ConfigFile.project(process.cwd()); }

  /** Does what a home entry says. A number ends the menu with that exit code. */
  private async perform(action: Action): Promise<number | undefined> {
    if (action.kind === 'settings') {
      await new SettingsEditor(this.app, this.fileFor(action.target), this.ctx.dataPath).run();
      this.applyAgentCommands();
      return undefined;
    }
    if (action.kind === 'apps') {
      this.notice = await new AppsCatalogue(this.app, this.fileFor(action.target), this.ctx.dataPath).run();
      return undefined;
    }
    const argv = action.kind === 'run' ? action.argv : action.kind === 'several' ? await new SeveralAgents(this.app, this.ctx).run() : await new CommandForm(this.app, this.ctx, commandSpec(action.command) as CommandSpecT, action.preset).run();
    return argv ? this.execute(argv) : undefined;
  }

  /** Runs an argv like typing it, on the normal screen; the menu comes back afterwards unless the command took over. */
  private async execute(argv: string[]): Promise<number | undefined> {
    const code = await this.app.suspend(async () => {
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H' + Theme.muted('$ ' + commandLine(argv)) + '\n\n');
      return this.runArgv(argv);
    });
    if (commandSpec(argv[0])?.interactive) return code;
    await pressAnyKey((code === 0 ? Theme.ok('Done.') : Theme.warn('Exit code ' + code + '.')) + Theme.muted(' Press any key for the menu…'));
    return undefined;
  }

  /** The settings screen may have switched agentCommands (Beta): apply it now, from the saved file. */
  private applyAgentCommands(): void {
    try { syncAgentCommands(this.ctx, loadConfig(this.ctx.loaded.configPath ?? undefined).config); } catch (e) { console.warn('Agent commands (Beta): ' + errMsg(e)); }
  }
}

/** Waits for one key on the normal screen, so a command's output stays until you have read it. Ctrl+C leaves. */
const pressAnyKey = (message: string): Promise<void> => new Promise((resolve, reject) => {
  process.stdout.write('\n' + message);
  const { stdin } = process;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.once('data', (key: Buffer) => {
    stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write('\n');
    if (key[0] === 3) reject(new ExitRequested()); else resolve();
  });
});

export const menu = (ctx: Context, run: (argv: string[]) => Promise<number>): Promise<number> => new Menu(ctx, run).start();
