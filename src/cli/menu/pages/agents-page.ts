// Section 1: the agents. "Start" lists the agents you can start here (Enter starts one) after "Repeat last", and ends
// with "Add an agent…" (the new one appears in the list); "Options" holds how a start goes (attach, window, folder) and
// the other ways to start; "On this PC" has the not-sandboxed entries while agent commands are on.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../../../core/config/index.js';
import type { Config } from '../../../core/types.js';
import { errMsg } from '../../../core/util/index.js';
import type { Context } from '../../commands/context.js';
import { commandLine, readHistory } from '../../history.js';
import { AgentCommandsService, type AgentCommandsStatus } from '../../services/index.js';
import { commandSpec, type CommandSpec } from '../../manifest.js';
import {
  Text,
  Theme,
  type App,
  type Category,
  type ListAction,
  type ListOptions,
  type ListResult,
} from '../../tui/index.js';
import { AddAgent, makeDefaultAgent, removeAgent } from '../add-agent.js';
import { CommandForm } from '../command-form.js';
import type { ConfigFile } from '../settings/config-file.js';
import type { Draft } from '../settings/draft.js';
import { askPath } from '../settings/path-kind.js';
import { SeveralAgents } from '../several.js';
import { ListPage, type Outcome } from './list-page.js';

export type WindowChoice = 'config' | 'hide' | 'show';

export interface AgentsModel {
  readonly folder: string;
  readonly defaultAgent: string;
  readonly agents: readonly { readonly name: string; readonly ready: boolean }[];
  readonly last: string[] | undefined;
  readonly attach: boolean;
  readonly window: WindowChoice;
  /** Agents that can be run on this PC without the sandbox (see hostAgentsToShow). */
  readonly hostAgents: readonly string[];
  /** The agents you added yourself: only these can be removed (the built-in ones stay). */
  readonly removable?: readonly string[];
}

/** The agents of `harnesses` that are not built in. Pure. */
export function addedAgents(names: readonly string[]): string[] {
  return names.filter((n) => !(n in DEFAULTS.harnesses));
}

const agentOf = (id: string): string | undefined => (id.startsWith('agent:') ? id.slice(6) : undefined);

/** The keys of the Start category: make an agent the default, remove one you added. Pure. */
export function agentActions(m: Pick<AgentsModel, 'defaultAgent' | 'removable'>): ListAction<string>[] {
  const isOther = (id: string): boolean => {
    const name = agentOf(id);
    return name !== undefined && name !== m.defaultAgent;
  };
  return [
    { key: 'd', label: 'make default', importance: 1, applies: isOther },
    {
      key: 'x',
      label: 'remove',
      importance: 1,
      applies: (id) => isOther(id) && (m.removable ?? []).includes(agentOf(id) ?? ''),
    },
  ];
}

/**
 * The "not sandboxed" entries: only while agent commands are on (typing the agent then starts the sandbox, so a way to
 * run the real one is needed), one per agent found installed on this PC.
 */
export function hostAgentsToShow(enabled: boolean, found: readonly { harness: string }[]): string[] {
  return enabled ? found.map((a) => a.harness) : [];
}

const WINDOW_TEXT: Record<WindowChoice, string> = { config: 'as configured', hide: 'hidden', show: 'shown' };

/** The command line a start stands for. Pure. */
export function startArgv(m: AgentsModel, agent: string, cwd: string): string[] {
  return [
    'launch',
    '--harness',
    agent,
    ...(m.attach ? ['--terminal'] : []),
    ...(m.window === 'hide' ? ['--headless'] : m.window === 'show' ? ['--window'] : []),
    ...(path.resolve(m.folder).toLowerCase() === path.resolve(cwd).toLowerCase() ? [] : ['--workspace', m.folder]),
  ];
}

/** The categories of the agents section; "On this PC" only when there is something in it. Pure. */
export function agentCategories(m: Pick<AgentsModel, 'folder' | 'hostAgents'>): Category[] {
  return [
    {
      id: 'start',
      label: 'Start',
      description: 'Agents you can start in ' + m.folder + '. Add an agent at the end of the list.',
    },
    { id: 'options', label: 'Options', description: 'How a start goes, and the other ways to start.' },
    ...(m.hostAgents.length
      ? [
          {
            id: 'host',
            label: 'On this PC',
            description: 'The real agents on this PC, with no sandbox around them.',
          },
        ]
      : []),
  ];
}

/** The list for the agents section. Pure. */
export function agentsOptions(m: AgentsModel, cwd: string = process.cwd()): ListOptions<string> {
  const section = 'Start in ' + path.basename(m.folder);
  const agents = [...m.agents].sort((a, b) => Number(b.name === m.defaultAgent) - Number(a.name === m.defaultAgent));
  return {
    path: [],
    categories: agentCategories(m),
    items: [
      ...(m.last
        ? [
            {
              value: 'repeat',
              label: 'Repeat last',
              category: 'start',
              section: 'Quick start',
              hint: Theme.muted(Text.truncate(commandLine(m.last), 50)),
              description: 'Runs the last command again.',
            },
          ]
        : []),
      ...agents.map((a) => ({
        value: 'agent:' + a.name,
        label: a.name,
        category: 'start',
        section,
        hint:
          (a.name === m.defaultAgent ? Theme.accent('default  ') : '') +
          (a.ready ? Theme.ok('ready') : Theme.muted('installs on first start')),
        description:
          'Starts ' +
          a.name +
          ' in ' +
          path.basename(m.folder) +
          '.' +
          (a.name === m.defaultAgent ? ' It is the default agent.' : '') +
          ((m.removable ?? []).includes(a.name) && a.name !== m.defaultAgent
            ? ' You added it: x removes it.'
            : (m.removable ?? []).includes(a.name)
              ? ' You added it. Make another agent the default to remove it.'
              : ''),
        details: [Theme.muted('Command  ') + commandLine(startArgv(m, a.name, cwd))],
      })),
      {
        value: 'add',
        label: 'Add an agent…',
        category: 'start',
        section,
        description:
          'Add another agent by its npm or Python package, or a program on this PC. It is saved in your settings and appears in this list.',
      },
      {
        value: 'opt:attach',
        label: 'Attach this terminal',
        category: 'options',
        section: 'This start',
        hint: m.attach ? Theme.ok('yes') : Theme.muted('no'),
        flip: true,
        description: 'Shows the agent in this terminal (Ctrl+] detaches). Without it the agent runs in the sandbox.',
      },
      {
        value: 'opt:window',
        label: 'Sandbox window',
        category: 'options',
        section: 'This start',
        hint: WINDOW_TEXT[m.window],
        description: 'Hide or show the Windows Sandbox window (sbx-show brings a hidden one back).',
      },
      {
        value: 'opt:folder',
        label: 'Folder',
        category: 'options',
        section: 'This start',
        hint: Text.middle(m.folder, 40),
        description: 'The project folder to work on.',
      },
      {
        value: 'more',
        label: 'More start options…',
        category: 'options',
        section: 'Start differently',
        description: 'Node and Python versions, databases, scripts and the rest of the start form.',
      },
      {
        value: 'several',
        label: 'Start several agents…',
        category: 'options',
        section: 'Start differently',
        description: 'One or more projects, one or more agents each, all in one sandbox.',
      },
      {
        value: 'noagent',
        label: 'Sandbox without an agent…',
        category: 'options',
        section: 'Start differently',
        description: 'Tools and databases only.',
      },
      ...m.hostAgents.map((agent) => ({
        value: 'host:' + agent,
        label: agent + ' (not sandboxed)',
        category: 'host',
        description: 'Runs the real ' + agent + ' on this PC, with no sandbox around it.',
      })),
    ],
    enterLabel: (_category, id) =>
      ENTER[id ?? ''] ?? (id?.startsWith('agent:') ? 'start' : id?.startsWith('host:') ? 'run' : 'open'),
    actions: (category) => (category === 'start' ? agentActions(m) : []),
  };
}

/** What Enter does on the rows that are not an agent. */
const ENTER: Readonly<Record<string, string>> = {
  repeat: 'run again',
  add: 'add',
  'opt:attach': 'switch',
  'opt:window': 'change',
  'opt:folder': 'choose',
};

export class AgentsPage extends ListPage<string> {
  readonly label = 'Agents';
  private attach = false;
  private window: WindowChoice = 'config';
  private folder = process.cwd();
  private model: AgentsModel | undefined;
  /** What load() looked up (programs on PATH, the history file): not asked again for every list that is built. */
  private facts: { readonly commands: AgentCommandsStatus; readonly last: string[] | undefined } | undefined;

  constructor(
    app: App,
    private readonly ctx: Context,
    /** Your own config file and its unsaved changes: where "Add an agent" writes to. */
    private readonly file: ConfigFile,
    private readonly draft: Draft,
  ) {
    super(app);
  }

  /** Every agent: the configured ones, and any added in Settings that is not saved yet. */
  private harnesses(): Config['harnesses'] {
    const config = this.file.userConfig();
    const staged = this.draft.has(this.file, ['harnesses'])
      ? (this.draft.value(this.file, ['harnesses']) as Config['harnesses'] | undefined)
      : undefined;
    return { ...config.harnesses, ...staged };
  }

  /** Is this agent already in the sandbox's persistent storage (so starting it needs no install)? */
  private installed(name: string, harnesses: Config['harnesses']): boolean {
    const h = harnesses[name];
    const dir = path.join(this.ctx.dataPath, 'tools', 'agents', name);
    return (
      Boolean(h) &&
      [h.hostExecutable, h.npmBin && h.npmBin + '.cmd', h.uvBin && h.uvBin + '.exe'].some(
        (f) => f && fs.existsSync(path.join(dir, f)),
      )
    );
  }

  private current(): AgentsModel {
    const harnesses = this.harnesses();
    if (!this.facts) throw new Error('The agents tab was not loaded');
    const { commands, last } = this.facts;
    return {
      folder: this.folder,
      defaultAgent: this.file.userConfig().defaultHarness,
      agents: Object.keys(harnesses).map((name) => ({ name, ready: this.installed(name, harnesses) })),
      last,
      attach: this.attach,
      window: this.window,
      hostAgents: hostAgentsToShow(commands.enabled, commands.found),
      removable: addedAgents(Object.keys(harnesses)),
    };
  }

  /** The cursor starts on the default agent. */
  protected override initialFocus(): string {
    return 'agent:' + this.file.userConfig().defaultHarness;
  }

  protected async load(): Promise<void> {
    this.facts = {
      commands: await new AgentCommandsService(this.ctx).statusAsync(),
      last: readHistory()[0]?.argv,
    };
    this.model = this.current();
  }

  protected options(): ListOptions<string> {
    this.model = this.current();
    return agentsOptions(this.model);
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    if (result.kind === 'action') return this.action(result.key, result.value);
    if (result.kind !== 'pick') return {};
    const id = result.value;
    const model = this.current();
    if (id.startsWith('host:')) return { exit: { kind: 'run', argv: ['host', id.slice(5)] } };
    if (id.startsWith('agent:')) return { exit: { kind: 'run', argv: startArgv(model, id.slice(6), process.cwd()) } };
    switch (id) {
      case 'repeat':
        return model.last ? { exit: { kind: 'run', argv: model.last } } : {};
      case 'add':
        return this.add(model);
      case 'opt:attach':
        this.attach = !this.attach;
        return {};
      case 'opt:window':
        this.window = this.window === 'config' ? 'hide' : this.window === 'hide' ? 'show' : 'config';
        return {};
      case 'opt:folder': {
        const picked = await askPath(this.app, {
          path: ['Agents', 'Folder'],
          title: 'Choose the project folder',
          kind: 'dir',
          initial: this.folder,
          validate: (v) => (fs.existsSync(path.resolve(v)) ? true : 'That folder does not exist.'),
        });
        if (picked) this.folder = path.resolve(picked);
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

  /** Make default (d) and Remove (x) on the highlighted agent. */
  private async action(key: string, id: string | undefined): Promise<Outcome<string>> {
    const name = id?.startsWith('agent:') ? id.slice(6) : undefined;
    if (!name) return {};
    try {
      if (key === 'd') {
        makeDefaultAgent(this.file, this.draft, name);
        return { focus: id, notice: Theme.ok(Theme.glyph.ok + ' ' + name + ' is the default agent.') };
      }
      if (key !== 'x') return {};
      const ok = await this.app.ask(
        'Remove ' + name + '?',
        ['It is taken out of your settings. Its files in the sandbox stay until you clean them up.'],
        'Remove',
        true,
      );
      if (!ok) return {};
      removeAgent(this.file, this.draft, name);
      return {
        focus: 'agent:' + this.file.userConfig().defaultHarness,
        notice: Theme.ok(Theme.glyph.ok + ' Removed ' + name + '.'),
      };
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
  }

  /** "Add an agent…": the new agent shows in the list, with the cursor on it. */
  private async add(model: AgentsModel): Promise<Outcome<string>> {
    try {
      const added = await new AddAgent(
        this.app,
        this.file,
        this.draft,
        model.agents.map((a) => a.name),
      ).run();
      if (!added) return {};
      return {
        focus: 'agent:' + added.name,
        notice:
          Theme.ok(Theme.glyph.ok + ' Added ' + added.name + '.') +
          Theme.muted(added.saved ? ' Enter starts it.' : ' Ctrl+S saves it.'),
      };
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
  }
}
