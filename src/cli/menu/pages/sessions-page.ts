// Tab 2: the agent sessions of the running sandbox. Enter shows one in this terminal (the one thing that leaves the
// menu), r restarts the agents.
import { errMsg, safeText } from '../../../core/util/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import type { Context } from '../../commands/context.js';
import { ago } from '../../output/index.js';
import { SessionsService, viewerText, type ListedSession } from '../../services/index.js';
import { Theme, type App, type ListOptions, type ListResult } from '../../tui/index.js';
import { ListPage, type Outcome } from './list-page.js';

export interface SessionsModel {
  readonly sandboxRunning: boolean;
  /** Newest first, this folder's project first. */
  readonly sessions: readonly ListedSession[];
}

/** The list for the sessions tab. Pure. */
export function sessionsOptions(m: SessionsModel): ListOptions<string> {
  return {
    path: [],
    intro: m.sandboxRunning
      ? undefined
      : 'No sandbox is running. Start one on the Start tab (1); its sessions are listed here.',
    items: m.sessions.map((s) => ({
      value: s.id,
      label: safeText(s.harness) + '  ' + safeText(s.projectName ?? '-'),
      hint: s.phase + (s.exitCode !== undefined ? ' (' + s.exitCode + ')' : '') + '  ' + ago(s.startedAt),
      section: s.here ? "This folder's project" : 'Other sessions',
      description:
        s.phase === 'running'
          ? 'Enter shows this session in this terminal (Ctrl+] detaches; the session keeps running).'
          : undefined,
      details: [
        Theme.muted('Session   ') + s.id,
        Theme.muted('Folder    ') + safeText(s.cwd),
        Theme.muted('Attached  ') + viewerText(s.viewers),
      ],
      ...(s.phase === 'running' ? {} : { disabled: 'This session has ended.' }),
    })),
    empty: 'No sessions yet.',
    actions: [
      { key: 'r', label: 'restart agents', importance: 1 },
      { key: 'o', label: 'reopen last sessions', importance: 2 },
      { key: 'l', label: 'refresh', importance: 3 },
    ],
    enterLabel: 'attach',
    escapeLabel: 'quit',
  };
}

export class SessionsPage extends ListPage<string> {
  readonly label = 'Sessions';
  private model: SessionsModel = { sandboxRunning: false, sessions: [] };
  private readonly service: SessionsService;

  constructor(app: App, ctx: Context) {
    super(app);
    this.service = new SessionsService(ctx);
  }

  protected async load(): Promise<void> {
    const sandboxRunning = isSandboxRunning();
    try {
      const list = sandboxRunning ? await this.service.list() : [];
      this.model = { sandboxRunning, sessions: this.service.ordered(list) };
    } catch (e) {
      this.model = { sandboxRunning, sessions: [] };
      this.say(Theme.error(Theme.glyph.cross + ' ' + errMsg(e)));
    }
  }

  protected options(): ListOptions<string> {
    return sessionsOptions(this.model);
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    if (result.kind === 'pick') return { exit: { kind: 'run', argv: ['attach', result.value] } };
    if (result.kind !== 'action') return {};
    if (result.key === 'l') return { reload: true };
    if (result.key === 'o') return { exit: { kind: 'run', argv: ['resume'] } };
    if (!this.model.sandboxRunning) return { notice: Theme.warn('No sandbox is running.') };
    const scope = this.service.restartScope(false);
    const what = scope.guest ? 'the agents of ' + scope.projectName : 'every agent';
    const ok = await this.app.ask(
      'Restart ' + what + '?',
      [
        'The agents are started again and continue their conversations where they can.',
        ...(scope.notAProject
          ? [scope.folder + ' is not a project of the running sandbox: every session restarts.']
          : []),
      ],
      'Restart',
    );
    if (!ok) return {};
    try {
      return {
        reload: true,
        notice: Theme.ok(Theme.glyph.ok + ' ' + safeText(await this.service.restart(null, scope.guest))),
      };
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
  }
}
