// Tab 6: saved logins. Claude's for now: save the sandbox's or this PC's login, switch to one, make one the default.
import { errMsg, safeText } from '../../../core/util/index.js';
import type { AccountRow } from '../../../host/profile/index.js';
import type { Context } from '../../commands/context.js';
import { AccountsService } from '../../services/index.js';
import { Theme, type App, type ListOptions, type ListResult } from '../../tui/index.js';
import { ListPage, type Outcome } from './list-page.js';

const NAME = /^[A-Za-z0-9_-]{1,40}$/;

/** The list for the accounts tab. Pure. */
export function accountsOptions(accounts: readonly AccountRow[]): ListOptions<string> {
  return {
    path: [],
    intro: 'Logins saved on this PC. Use puts one into the sandbox; new launches start with the default.',
    categories: [{ id: 'claude', label: 'Claude', description: 'Saved Claude logins.' }],
    items: accounts.map((a) => ({
      value: a.name,
      label: a.name,
      category: 'claude',
      hint:
        (a.isActive ? Theme.ok('in the sandbox') : '') +
        (a.isActive && a.isDefault ? Theme.muted(' · ') : '') +
        (a.isDefault ? Theme.accent('default') : ''),
      description: 'Enter makes the sandbox use this login.',
      details: [
        Theme.muted('Email  ') + safeText(a.email ?? '-'),
        Theme.muted('Saved  ') + a.savedAt.slice(0, 16).replace('T', ' '),
      ],
    })),
    empty: "No saved accounts. Sign in inside the sandbox, then press s to save that login (p saves this PC's).",
    actions: [
      { key: 's', label: 'save sandbox', importance: 1 },
      { key: 'p', label: 'save PC', importance: 1 },
      { key: 'd', label: 'default', importance: 1 },
      { key: 'x', label: 'remove', importance: 1 },
    ],
    enterLabel: 'use',
    escapeLabel: 'quit',
  };
}

export class AccountsPage extends ListPage<string> {
  readonly label = 'Accounts';
  private rows: AccountRow[] = [];
  private readonly service: AccountsService;

  constructor(app: App, ctx: Context) {
    super(app);
    this.service = new AccountsService(ctx);
  }

  protected load(): Promise<void> {
    this.rows = this.service.list();
    return Promise.resolve();
  }

  protected options(): ListOptions<string> {
    return accountsOptions(this.rows);
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    try {
      if (result.kind === 'action' && (result.key === 's' || result.key === 'p'))
        return await this.save(result.key === 'p');
      if (result.kind === 'pick') return await this.use(result.value);
      if (result.kind === 'action' && result.value !== undefined) {
        if (result.key === 'd') {
          this.service.setDefault(result.value);
          return {
            reload: true,
            notice: Theme.ok(Theme.glyph.ok + ' ' + result.value + ' is the default for new launches.'),
          };
        }
        if (result.key === 'x') return await this.remove(result.value);
      }
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
    return {};
  }

  private async save(fromHost: boolean): Promise<Outcome<string>> {
    const name = await this.app.text({
      path: ['Accounts', fromHost ? "Save this PC's login" : "Save the sandbox's login"],
      label: 'Name for this login',
      about: [
        fromHost
          ? 'Saves the Claude login of this PC (the one `claude` uses here).'
          : 'Saves the login you signed in with inside the sandbox.',
      ],
      validate: (v) => (NAME.test(v.trim()) ? true : 'Use letters, digits, - and _ (up to 40).'),
    });
    if (!name) return {};
    const saved = this.service.save(name.trim(), fromHost);
    return { reload: true, focus: saved.name, notice: Theme.ok(Theme.glyph.ok + ' Saved "' + saved.name + '".') };
  }

  private async use(name: string): Promise<Outcome<string>> {
    const account = this.service.activate(name);
    let note = Theme.ok(Theme.glyph.ok + ' The sandbox now uses "' + account.name + '".');
    if (
      this.service.hasRunningClaude() &&
      (await this.app.ask(
        'Restart the running Claude sessions?',
        ['They restart with --continue, so the conversation carries on under the new account.'],
        'Restart',
      ))
    )
      note += ' ' + safeText(await this.service.restartClaude());
    return { reload: true, notice: note };
  }

  private async remove(name: string): Promise<Outcome<string>> {
    if (!(await this.app.ask('Remove "' + name + '"?', ['The saved login is deleted from this PC.'], 'Remove', true)))
      return {};
    this.service.remove(name);
    return { reload: true, focus: undefined, notice: Theme.ok(Theme.glyph.ok + ' Removed "' + name + '".') };
  }
}
