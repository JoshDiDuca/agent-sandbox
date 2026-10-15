// Section 2: the agent sessions of the running sandbox. Enter shows one in this terminal (the one thing that leaves the
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
  /** The agent "Start" offers while there is no session. */
  readonly defaultAgent: string;
}

const START = '@start';

/** The list for the sessions tab. Pure. */
export function sessionsOptions(m: SessionsModel): ListOptions<string> {
  return {
    path: [],
    items: m.sessions.length
      ? m.sessions.map((s) => ({
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
        }))
      : [
          {
            value: START,
            label: 'Start ' + m.defaultAgent,
            hint: Theme.muted('default agent'),
            section: m.sandboxRunning ? 'No sessions' : 'No sandbox is running',
            description: m.sandboxRunning
              ? 'No agent is running. Enter starts ' + m.defaultAgent + ' in this folder.'
              : 'Enter starts the sandbox and ' + m.defaultAgent + ' in this folder; its session is listed here.',
          },
        ],
    actions: [
      { key: 'r', label: 'restart agents', importance: 1, applies: (id) => id !== START },
      { key: 'o', label: 'reopen last sessions', importance: 2 },
      { key: 'l', label: 'refresh', importance: 3 },
    ],
    enterLabel: (_category, id) => (id === START ? 'start' : 'attach'),
  };
}

export class SessionsPage extends ListPage<string> {
  readonly label = 'Sessions';
  private model: SessionsModel;
  private readonly service: SessionsService;

  constructor(
    app: App,
    private readonly ctx: Context,
  ) {
    super(app);
    this.service = new SessionsService(ctx);
    this.model = { sandboxRunning: false, sessions: [], defaultAgent: this.defaultAgent() };
  }

  private defaultAgent(): string {
    return this.ctx.loaded.config.defaultHarness;
  }

  protected async load(): Promise<void> {
    const sandboxRunning = isSandboxRunning();
    try {
      const list = sandboxRunning ? await this.service.list() : [];
      this.model = { sandboxRunning, sessions: this.service.ordered(list), defaultAgent: this.defaultAgent() };
    } catch (e) {
      this.model = { sandboxRunning, sessions: [], defaultAgent: this.defaultAgent() };
      this.say(Theme.error(Theme.glyph.cross + ' ' + errMsg(e)));
    }
  }

  protected options(): ListOptions<string> {
    return sessionsOptions(this.model);
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    if (result.kind === 'pick' && result.value === START)
      return { exit: { kind: 'run', argv: ['launch', '--harness', this.model.defaultAgent] } };
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
