// Section 6: saved logins for every agent. Agents on the left (each with its logins), actions on the right: save the
// sandbox's login or this PC's, use one, make one the default, rename, remove.
import { errMsg, safeText } from '../../../core/util/index.js';
import type { AccountRow } from '../../../host/profile/index.js';
import type { Context } from '../../commands/context.js';
import { AccountsService, type AgentAccounts } from '../../services/index.js';
import { Theme, type App, type ListAction, type ListItem, type ListOptions, type ListResult } from '../../tui/index.js';
import { ListPage, type Outcome } from './list-page.js';

const NAME = /^[A-Za-z0-9_-]{1,40}$/;

const SAVE_SANDBOX = '@save-sandbox';
const SAVE_PC = '@save-pc';

/** A saved login (not a "save a login" row or a note). */
const isLogin = (id: string): boolean => !id.startsWith('@') && !id.startsWith('info:');

export interface AccountsModel {
  readonly agents: readonly AgentAccounts[];
  /** Saved logins by agent name. */
  readonly rows: Readonly<Record<string, readonly AccountRow[]>>;
}

/** The list for the accounts tab. Pure. */
export function accountsOptions(m: AccountsModel): ListOptions<string> {
  return {
    path: [],
    intro: 'Logins saved on this PC, per agent. Use puts one into the sandbox; new launches start with the default.',
    categories: m.agents.map((a) => ({
      id: a.name,
      label: a.name,
      description: a.kept
        ? 'Saved ' + a.name + ' logins.'
        : "This agent's login is not kept between sandboxes: it cannot be pointed at a folder we control.",
    })),
    items: m.agents.flatMap((a) => {
      const rows = m.rows[a.name] ?? [];
      const save: ListItem<string>[] = [
        {
          value: SAVE_SANDBOX,
          label: "+ Save the sandbox's login…",
          category: a.name,
          section: 'Save a login',
          description: 'Saves the ' + a.name + ' login you signed in with inside the sandbox, under a name you choose.',
        },
        ...(a.canSavePc
          ? [
              {
                value: SAVE_PC,
                label: "+ Save this PC's login…",
                category: a.name,
                section: 'Save a login',
                description: 'Saves the ' + a.name + ' login of this PC, under a name you choose.',
              },
            ]
          : []),
      ];
      if (!a.kept)
        return [
          {
            value: 'info:' + a.name,
            label: Theme.muted("This agent's login is not kept between sandboxes"),
            category: a.name,
            description: 'Sign in again in each new sandbox, or use an API key in the agent’s environment.',
          },
        ];
      return [
        ...save,
        ...rows.map((r) => ({
          value: a.name + ':' + r.name,
          label: r.name,
          category: a.name,
          section: 'Saved logins',
          hint:
            (r.isActive ? Theme.ok('in the sandbox') : '') +
            (r.isActive && r.isDefault ? Theme.muted(' · ') : '') +
            (r.isDefault ? Theme.accent('default') : ''),
          description: 'Enter makes the sandbox use this login.',
          details: [
            Theme.muted('Agent  ') + a.name,
            Theme.muted('Email  ') + safeText(r.email ?? '-'),
            Theme.muted('Saved  ') + r.savedAt.slice(0, 16).replace('T', ' '),
          ],
        })),
      ];
    }),
    empty: 'No agents.',
    actions: accountActions(m.agents),
    enterLabel: (_category, id) => (id === SAVE_SANDBOX || id === SAVE_PC ? 'save' : id && isLogin(id) ? 'use' : ''),
  };
}

function accountActions(agents: readonly AgentAccounts[]): (category: string | undefined) => ListAction<string>[] {
  return (category) => {
    const agent = agents.find((a) => a.name === category);
    if (!agent?.kept) return [];
    return [
      { key: 's', label: 'save sandbox login', importance: 3 },
      ...(agent.canSavePc ? [{ key: 'p', label: 'save PC login', importance: 3 }] : []),
      { key: 'd', label: 'make default', importance: 1, applies: isLogin },
      { key: 'r', label: 'rename', importance: 2, applies: isLogin },
      { key: 'x', label: 'remove', importance: 1, applies: isLogin },
    ];
  };
}

export class AccountsPage extends ListPage<string> {
  readonly label = 'Accounts';
  private model: AccountsModel = { agents: [], rows: {} };
  private readonly service: AccountsService;

  constructor(app: App, ctx: Context) {
    super(app);
    this.service = new AccountsService(ctx);
  }

  protected load(): Promise<void> {
    const agents = this.service.agents();
    const rows: Record<string, AccountRow[]> = {};
    for (const a of agents.filter((x) => x.kept)) {
      try {
        rows[a.name] = this.service.list(a.name);
      } catch {
        rows[a.name] = [];
      }
    }
    this.model = { agents, rows };
    return Promise.resolve();
  }

  protected options(): ListOptions<string> {
    return accountsOptions(this.model);
  }

  /** The agent of the open category, and the login name of an item value ("agent:name"). */
  private agentNow(): string {
    return this.category ?? 'claude';
  }
  private static nameOf(value: string | undefined): string | undefined {
    const i = value?.indexOf(':') ?? -1;
    return value && i >= 0 && isLogin(value) ? value.slice(i + 1) : undefined;
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    const agent = this.agentNow();
    const name = AccountsPage.nameOf(result.kind === 'pick' || result.kind === 'action' ? result.value : undefined);
    try {
      if (result.kind === 'action' && (result.key === 's' || result.key === 'p'))
        return await this.save(agent, result.key === 'p');
      if (result.kind === 'pick' && (result.value === SAVE_SANDBOX || result.value === SAVE_PC))
        return await this.save(agent, result.value === SAVE_PC);
      if (result.kind === 'pick' && name) return await this.use(agent, name);
      if (result.kind === 'action' && name) {
        if (result.key === 'd') {
          this.service.setDefault(name, agent);
          return { reload: true, notice: Theme.ok(Theme.glyph.ok + ' ' + name + ' is the default for new launches.') };
        }
        if (result.key === 'x') return await this.remove(agent, name);
        if (result.key === 'r') return await this.rename(agent, name);
      }
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
    return {};
  }

  private askName(title: string, about: string, initial = ''): Promise<string | undefined> {
    return this.app.text({
      path: ['Accounts', title],
      label: 'Name for this login',
      about: [about],
      initial,
      validate: (v) => (NAME.test(v.trim()) ? true : 'Use letters, digits, - and _ (up to 40).'),
    });
  }

  private async save(agent: string, fromHost: boolean): Promise<Outcome<string>> {
    const name = await this.askName(
      fromHost ? "Save this PC's " + agent + ' login' : "Save the sandbox's " + agent + ' login',
      fromHost ? 'Saves the ' + agent + ' login of this PC.' : 'Saves the login you signed in with inside the sandbox.',
    );
    if (!name) return {};
    const saved = this.service.save(name.trim(), fromHost, agent);
    return {
      reload: true,
      focus: agent + ':' + saved.name,
      notice: Theme.ok(Theme.glyph.ok + ' Saved "' + saved.name + '".'),
    };
  }

  private async rename(agent: string, name: string): Promise<Outcome<string>> {
    const to = await this.askName('Rename "' + name + '"', 'The login keeps working under its new name.', name);
    if (!to || to.trim() === name) return {};
    this.service.rename(name, to.trim(), agent);
    return {
      reload: true,
      focus: agent + ':' + to.trim(),
      notice: Theme.ok(Theme.glyph.ok + ' Renamed to "' + to.trim() + '".'),
    };
  }

  private async use(agent: string, name: string): Promise<Outcome<string>> {
    const account = this.service.activate(name, agent);
    let note = Theme.ok(Theme.glyph.ok + ' The sandbox now uses "' + account.name + '" for ' + agent + '.');
    if (account.note) note += ' ' + safeText(account.note);
    if (
      this.service.hasRunningSessions(agent) &&
      (await this.app.ask(
        'Restart the running ' + agent + ' sessions?',
        ['They restart and continue their conversation where the agent can, now under the new login.'],
        'Restart',
      ))
    )
      note += ' ' + safeText(await this.service.restart(agent));
    return { reload: true, notice: note };
  }

  private async remove(agent: string, name: string): Promise<Outcome<string>> {
    if (!(await this.app.ask('Remove "' + name + '"?', ['The saved login is deleted from this PC.'], 'Remove', true)))
      return {};
    this.service.remove(name, agent);
    return { reload: true, notice: Theme.ok(Theme.glyph.ok + ' Removed "' + name + '".') };
  }
}
