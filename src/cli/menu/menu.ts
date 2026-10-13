// The interactive menu (`sandbox` with no arguments): a full-screen app. The home screen groups everything into
// categories (start, sessions, sandbox, apps, settings ...); commands open as a form that shows the exact command line,
// which then runs like typing it. Settings and the project's .sandbox-config.json are edited in place.
import fs from 'node:fs';
import path from 'node:path';
import { errMsg, plainText } from '../../core/util/index.js';
import { loadConfig } from '../../core/config/index.js';
import { SandboxChannel } from '../../host/channel/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import { syncAgentCommands } from '../commands/agent-commands.js';
import type { Context } from '../commands/context.js';
import { commandLine, readHistory } from '../history.js';
import { COMMANDS, commandSpec, type CommandSpec } from '../manifest.js';
import { App, ExitRequested, Frame, Text, Theme, type ListItem } from '../tui/index.js';
import { AppsCatalogue, appsSummary } from './apps.js';
import { CommandForm } from './command-form.js';
import { ConfigFile, SettingsEditor } from './settings/index.js';
import { SeveralAgents } from './several.js';
import { type Action, CATEGORY_OF_GROUP, TITLES, CATEGORIES } from './home.js';

export class Menu {
  private readonly app = new App();
  private last: string | undefined;
  /** The result of the last action (saved apps ...), shown on the home screen once. */
  private notice: string | undefined;

  constructor(
    private readonly ctx: Context,
    private readonly runArgv: (argv: string[]) => Promise<number>,
  ) {
    this.app.status = () => this.status();
    try {
      Frame.version =
        (JSON.parse(fs.readFileSync(path.join(ctx.packageRoot, 'package.json'), 'utf8')) as { version?: string })
          .version ?? '';
    } catch {
      /* no version shown */
    }
  }

  private status(): string {
    const folder = Theme.muted(Text.middle(process.cwd(), 70));
    if (!isSandboxRunning()) return Theme.muted(Theme.glyph.off + ' No sandbox running') + '   ' + folder;
    const n = new SandboxChannel(this.ctx.dataPath).runningSessions().length;
    return (
      Theme.ok(Theme.glyph.on + ' Sandbox running') +
      Theme.muted(' · ' + n + ' session' + (n === 1 ? '' : 's')) +
      '   ' +
      folder
    );
  }

  /** Is this agent already in the sandbox's persistent storage (so starting it needs no install)? */
  private installed(name: string): boolean {
    const h = this.ctx.loaded.config.harnesses[name];
    const dir = path.join(this.ctx.dataPath, 'tools', 'agents', name);
    return (
      Boolean(h) &&
      [h.hostExecutable, h.npmBin && h.npmBin + '.cmd', h.uvBin && h.uvBin + '.exe'].some(
        (f) => f && fs.existsSync(path.join(dir, f)),
      )
    );
  }

  private homeItems(): ListItem<string>[] {
    const config = this.ctx.loaded.config;
    const def = config.defaultHarness;
    const last = readHistory()[0];
    const items: ListItem<string>[] = [];
    const add = (
      category: string,
      section: string,
      label: string,
      action: Action,
      description?: string,
      hint?: string,
    ): void => {
      items.push({ value: JSON.stringify(action), label, category, section, description, hint });
    };

    if (last)
      add(
        'start',
        'Quick start',
        'Repeat last',
        { kind: 'run', argv: last.argv },
        'Runs the last command again.',
        Theme.muted(Text.truncate(commandLine(last.argv), 50)),
      );
    add(
      'start',
      'Quick start',
      'Start ' + def + ' in this folder',
      { kind: 'run', argv: ['launch', '--harness', def] },
      'Starts ' + def + ' in a sandbox for ' + process.cwd() + ' (or another session in the running sandbox).',
      this.installed(def) ? Theme.ok('ready') : Theme.muted('installs on first start'),
    );
    add(
      'start',
      'Quick start',
      'Start ' + def + ' with options…',
      { kind: 'form', command: 'launch', preset: ['--harness', def] },
      'Choose options first: attach this terminal, Node or Python version, databases, scripts ...',
    );
    add(
      'start',
      'Quick start',
      'Start several agents…',
      { kind: 'several' },
      'One or more projects, one or more agents each, all in one sandbox; attach to any of them.',
    );
    for (const name of Object.keys(config.harnesses).filter((n) => n !== def))
      add(
        'start',
        'Other agents',
        'Start ' + name,
        { kind: 'form', command: 'launch', preset: ['--harness', name] },
        'Opens the start form for ' + name + '.',
        this.installed(name) ? Theme.ok('ready') : Theme.muted('installs on first start'),
      );

    if (isSandboxRunning()) {
      for (const s of new SandboxChannel(this.ctx.dataPath).runningSessions().slice(-12)) {
        add(
          'sessions',
          'Running now',
          plainText(s.harness) + ' · ' + plainText(path.win32.basename(s.cwd)),
          { kind: 'run', argv: ['attach', plainText(s.id)] },
          'Shows this session in this terminal (Ctrl+] detaches; the session keeps running).',
          Theme.muted(plainText(s.id)),
        );
      }
    }
    const userFile = ConfigFile.user(this.ctx.loaded.configPath);
    add(
      'apps',
      'Apps',
      'Browse the apps catalogue…',
      { kind: 'apps', target: 'user' },
      'Tick the apps every sandbox should have: by category, searchable, with sizes. Each downloads once and is kept.',
      Theme.muted(appsSummary(userFile)),
    );
    add(
      'apps',
      'Apps',
      'Apps for this project only…',
      { kind: 'apps', target: 'project' },
      'Catalogue apps this project needs (saved in its .sandbox-config.json, added to yours).',
    );
    add(
      'settings',
      'Settings',
      'Settings for all projects',
      { kind: 'settings', target: 'user' },
      "Your own settings, used by every project: languages, databases, the sandbox machine, agents, security ... (Tab switches to this project's.)",
      Theme.scopeGlobal(' YOURS '),
    );
    add(
      'settings',
      'Settings',
      'Settings for this project',
      { kind: 'settings', target: 'project' },
      "This folder's .sandbox-config.json: only what a project may set, on top of yours. A changed file needs your approval at the next launch. (Tab switches to all projects.)",
      Theme.scopeProject(' PROJECT '),
    );

    for (const spec of COMMANDS.filter((s) => !s.hidden && s.name !== 'launch')) {
      const category = CATEGORY_OF_GROUP[spec.group];
      const section = category === 'start' ? 'More' : category === 'settings' ? 'Tools' : 'Commands';
      add(
        category,
        section,
        TITLES[spec.name] ?? Text.humanize(spec.name),
        { kind: 'form', command: spec.name },
        spec.summary.replace(/^./, (c) => c.toUpperCase()) + '.',
        Theme.muted('sandbox ' + spec.name),
      );
    }
    return items;
  }

  /** Runs the menu until you leave it, or until a command that takes over the terminal (launch, attach) has run. */
  async start(): Promise<number> {
    if (!process.stdin.isTTY) {
      console.log('The menu needs an interactive terminal. Run sandbox --help for the commands.');
      return 1;
    }
    try {
      for (;;) {
        const picked = await this.app.list<string>({
          path: [],
          items: this.homeItems(),
          categories: CATEGORIES,
          startAt: this.last,
          escapeLabel: 'quit',
          notice: this.notice,
        });
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

  private fileFor(target: 'user' | 'project'): ConfigFile {
    return target === 'user' ? ConfigFile.user(this.ctx.loaded.configPath) : ConfigFile.project(process.cwd());
  }

  /** Does what a home entry says. A number ends the menu with that exit code. */
  private async perform(action: Action): Promise<number | undefined> {
    if (action.kind === 'settings') {
      await new SettingsEditor(
        this.app,
        { user: this.fileFor('user'), project: this.fileFor('project') },
        action.target,
        this.ctx.dataPath,
      ).run();
      this.applyAgentCommands();
      return undefined;
    }
    if (action.kind === 'apps') {
      this.notice = await new AppsCatalogue(this.app, this.fileFor(action.target), this.ctx.dataPath).run();
      return undefined;
    }
    const argv =
      action.kind === 'run'
        ? action.argv
        : action.kind === 'several'
          ? await new SeveralAgents(this.app, this.ctx).run()
          : await new CommandForm(this.app, this.ctx, commandSpec(action.command) as CommandSpec, action.preset).run();
    return argv ? this.execute(argv) : undefined;
  }

  /** Runs an argv like typing it, on the normal screen; the menu comes back afterwards unless the command took over. */
  private async execute(argv: string[]): Promise<number | undefined> {
    const code = await this.app.suspend(async () => {
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H' + Theme.muted('$ ' + commandLine(argv)) + '\n\n');
      return this.runArgv(argv);
    });
    if (commandSpec(argv[0])?.interactive) return code;
    await pressAnyKey(
      (code === 0 ? Theme.ok('Done.') : Theme.warn('Exit code ' + code + '.')) +
        Theme.muted(' Press any key for the menu…'),
    );
    return undefined;
  }

  /** The settings screen may have switched agentCommands (Beta): apply it now, from the saved file. */
  private applyAgentCommands(): void {
    try {
      syncAgentCommands(this.ctx, loadConfig(this.ctx.loaded.configPath ?? undefined).config);
    } catch (e) {
      console.warn('Agent commands (Beta): ' + errMsg(e));
    }
  }
}

/** Waits for one key on the normal screen, so a command's output stays until you have read it. Ctrl+C leaves. */
function pressAnyKey(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write('\n' + message);
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', (key: Buffer) => {
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (key[0] === 3) reject(new ExitRequested());
      else resolve();
    });
  });
}
