// Tab 1: start an agent here. The agents are listed (Enter starts one), with the few options that matter right under
// them; everything else is behind "More options…" (the full start form).
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '../../commands/context.js';
import { commandLine, readHistory } from '../../history.js';
import { commandSpec, type CommandSpec } from '../../manifest.js';
import { Text, Theme, type App, type ListOptions, type ListResult } from '../../tui/index.js';
import { CommandForm } from '../command-form.js';
import { SeveralAgents } from '../several.js';
import { ListPage, type Outcome } from './list-page.js';

export type WindowChoice = 'config' | 'hide' | 'show';

export interface StartModel {
  readonly folder: string;
  readonly defaultAgent: string;
  readonly agents: readonly { readonly name: string; readonly ready: boolean }[];
  readonly last: string[] | undefined;
  readonly attach: boolean;
  readonly window: WindowChoice;
}

const WINDOW_TEXT: Record<WindowChoice, string> = { config: 'as configured', hide: 'hidden', show: 'shown' };

/** The command line a start stands for. Pure. */
export function startArgv(m: StartModel, agent: string, cwd: string): string[] {
  return [
    'launch',
    '--harness',
    agent,
    ...(m.attach ? ['--terminal'] : []),
    ...(m.window === 'hide' ? ['--headless'] : m.window === 'show' ? ['--window'] : []),
    ...(path.resolve(m.folder).toLowerCase() === path.resolve(cwd).toLowerCase() ? [] : ['--workspace', m.folder]),
  ];
}

/** The list for the start tab. Pure. */
export function startOptions(m: StartModel, cwd: string = process.cwd()): ListOptions<string> {
  const section = 'Start in ' + path.basename(m.folder);
  const agents = [...m.agents].sort((a, b) => Number(b.name === m.defaultAgent) - Number(a.name === m.defaultAgent));
  return {
    path: [],
    intro: m.folder,
    items: [
      ...(m.last
        ? [
            {
              value: 'repeat',
              label: 'Repeat last',
              section: 'Quick start',
              hint: Theme.muted(Text.truncate(commandLine(m.last), 50)),
              description: 'Runs the last command again.',
            },
          ]
        : []),
      ...agents.map((a) => ({
        value: 'agent:' + a.name,
        label: 'Start ' + a.name,
        section,
        hint:
          (a.name === m.defaultAgent ? Theme.accent('default  ') : '') +
          (a.ready ? Theme.ok('ready') : Theme.muted('installs on first start')),
        description: 'Runs: ' + commandLine(startArgv(m, a.name, cwd)),
      })),
      {
        value: 'opt:attach',
        label: 'Attach this terminal',
        section: 'Options',
        hint: m.attach ? Theme.ok('yes') : Theme.muted('no'),
        description: 'Shows the agent in this terminal (Ctrl+] detaches). Without it the agent runs in the sandbox.',
      },
      {
        value: 'opt:window',
        label: 'Sandbox window',
        section: 'Options',
        hint: WINDOW_TEXT[m.window],
        description: 'Hide or show the Windows Sandbox window (sbx-show brings a hidden one back).',
      },
      {
        value: 'opt:folder',
        label: 'Folder',
        section: 'Options',
        hint: Text.middle(m.folder, 40),
        description: 'The project folder to work on.',
      },
      {
        value: 'more',
        label: 'More options…',
        section: 'More',
        description: 'Node and Python versions, databases, scripts and the rest of the start form.',
      },
      {
        value: 'several',
        label: 'Start several agents…',
        section: 'More',
        description: 'One or more projects, one or more agents each, all in one sandbox.',
      },
      {
        value: 'noagent',
        label: 'Start a sandbox without an agent…',
        section: 'More',
        description: 'Tools and databases only.',
      },
    ],
    enterLabel: 'start',
    escapeLabel: 'quit',
  };
}

export class StartPage extends ListPage<string> {
  readonly label = 'Start';
  private attach = false;
  private window: WindowChoice = 'config';
  private folder = process.cwd();
  private model: StartModel | undefined;

  constructor(
    app: App,
    private readonly ctx: Context,
  ) {
    super(app);
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

  private current(): StartModel {
    const config = this.ctx.loaded.config;
    return {
      folder: this.folder,
      defaultAgent: config.defaultHarness,
      agents: Object.keys(config.harnesses).map((name) => ({ name, ready: this.installed(name) })),
      last: readHistory()[0]?.argv,
      attach: this.attach,
      window: this.window,
    };
  }

  protected load(): Promise<void> {
    this.model = this.current();
    return Promise.resolve();
  }

  protected options(): ListOptions<string> {
    this.model = this.current();
    return startOptions(this.model);
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    if (result.kind !== 'pick') return {};
    const id = result.value;
    const model = this.current();
    if (id.startsWith('agent:')) return { exit: { kind: 'run', argv: startArgv(model, id.slice(6), process.cwd()) } };
    switch (id) {
      case 'repeat':
        return model.last ? { exit: { kind: 'run', argv: model.last } } : {};
      case 'opt:attach':
        this.attach = !this.attach;
        return {};
      case 'opt:window':
        this.window = this.window === 'config' ? 'hide' : this.window === 'hide' ? 'show' : 'config';
        return {};
      case 'opt:folder': {
        const typed = await this.app.text({
          path: ['Start', 'Folder'],
          label: 'Project folder',
          initial: this.folder,
          validate: (v) => (fs.existsSync(path.resolve(v)) ? true : 'That folder does not exist.'),
        });
        if (typed) this.folder = path.resolve(typed);
        return {};
      }
      case 'more': {
        const argv = await new CommandForm(
          this.app,
          this.ctx,
          commandSpec('launch') as CommandSpec,
          startArgv(model, model.defaultAgent, process.cwd()).slice(1),
        ).run();
        return argv ? { exit: { kind: 'run', argv } } : {};
      }
      case 'several': {
        const argv = await new SeveralAgents(this.app, this.ctx).run();
        return argv ? { exit: { kind: 'run', argv } } : {};
      }
      case 'noagent': {
        const argv = await new CommandForm(this.app, this.ctx, commandSpec('start') as CommandSpec).run();
        return argv ? { exit: { kind: 'run', argv } } : {};
      }
      default:
        return {};
    }
  }
}
