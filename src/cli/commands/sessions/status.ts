import { safeText } from '../../../core/util/index.js';
import type { RegistryEntry } from '../../../host/projects/index.js';
import { printJson, table, ago, c, shortenMiddle, termWidth } from '../../output/index.js';
import { SandboxService, type ProjectInfo } from '../../services/index.js';
import type { Context } from '../context.js';
import { lookAtSandbox } from '../shared-use.js';

const MECHANISM_TEXT = {
  launch: 'started from here',
  root: 'in a project root',
  boot: 'mapped at start',
} as const satisfies Partial<Record<RegistryEntry['mechanism'], string>>;

function mechanismText(mechanism: RegistryEntry['mechanism']): string {
  return mechanism in MECHANISM_TEXT ? MECHANISM_TEXT[mechanism as keyof typeof MECHANISM_TEXT] : 'wsb share';
}

function printProject(p: ProjectInfo): void {
  console.log(
    (p.here ? '* ' : '  ') +
      c.bold(p.name) +
      '  ' +
      p.host +
      '  ->  ' +
      p.guest +
      c.dim('  (' + mechanismText(p.mechanism) + ')'),
  );
  console.log(
    '      setup: ' +
      p.setup.phase +
      (p.setup.phase === 'ready' ? '' : ' - ' + shortenMiddle(p.setup.message, termWidth() - 20)),
  );
  if (p.databases.length)
    console.log('      databases: ' + p.databases.map((d) => d.database + ' :' + d.port + ' ' + d.state).join(', '));
  for (const s of p.sessions)
    console.log('      session ' + s.id + '  ' + s.harness + '  ' + s.viewers + '  ' + ago(s.started));
  for (const f of p.repoGuard) console.log('      ' + c.yellow('guard: ' + f));
}

/** "pong (2 session(s) running)" from the helper in the sandbox, in plain words. */
export function helperText(answer: string): string {
  const sessions = /^pong \((\d+) session/.exec(answer);
  if (!sessions) return answer === '-' ? '-' : safeText(answer);
  return 'responding, ' + sessions[1] + (sessions[1] === '1' ? ' session' : ' sessions') + ' running';
}

export async function status(asked: Context): Promise<number> {
  // Another user's sandbox: shared, it is shown from their folders; not shared, only whose it is.
  const view = lookAtSandbox(asked);
  const ctx = view.ctx;
  if (view.limited) {
    const owner = view.owner;
    const user = owner?.kind === 'other' ? owner.user : null;
    if (!printJson(ctx, { sandbox: { running: true, shared: false, startedBy: user } })) console.log(view.line);
    return 0;
  }
  const report = await new SandboxService(ctx).status();
  const { startedAt, ...state } = report.sandbox;
  const info = {
    // Same keys and order as the service's state, with the start time shown as an uptime.
    sandbox: {
      ...(ctx.borrowed ? { startedBy: ctx.borrowed.user, shared: true } : {}),
      running: state.running,
      phase: state.phase,
      message: state.message,
      headless: state.headless,
      uptime: state.running && startedAt ? ago(startedAt).replace(' ago', '') : null,
      daemon: state.daemon,
      account: state.account,
      syncWatcher: state.syncWatcher,
    },
    here: report.here,
    roots: report.roots,
    projects: report.projects,
    otherSessions: report.otherSessions,
    repoGuard: report.repoGuard,
  };
  if (printJson(ctx, info)) return 0;
  const sb = info.sandbox;
  if (view.line) console.log(c.bold(view.line) + c.dim('. Its window is on their desktop; use its agents here.'));
  table([
    ...(ctx.borrowed ? [['Started by', safeText(ctx.borrowed.user)]] : []),
    ['Running', sb.running ? 'yes' : 'no'],
    ...(sb.running
      ? [
          ['Phase', safeText(sb.phase ?? '-')],
          ['Message', safeText(sb.message ?? '-')],
          ['Window', sb.headless ? 'hidden (sandbox show opens it)' : 'shown'],
          ['Uptime', sb.uptime ?? '-'],
          ['Helper', helperText(sb.daemon)],
        ]
      : []),
    ['Account', sb.account ? safeText(sb.account) : 'none selected (sandbox account use)'],
    ['Background sync', sb.syncWatcher ? 'on' : 'off'],
  ]);
  if (!state.running) return 0;
  console.log('\n' + c.bold('Projects'));
  for (const p of info.projects) printProject(p);
  for (const r of info.roots)
    console.log('  root  ' + r.host + '  ->  ' + r.guest + c.dim('  (every project in it opens without a restart)'));
  console.log(
    c.dim(
      info.projects.some((p) => p.here)
        ? '* = the project of this folder'
        : info.here.folder + ' is not in this sandbox (start it here: sandbox claude)',
    ),
  );
  for (const s of info.otherSessions) console.log('  session ' + s.id + '  ' + s.harness + '  ' + s.cwd);
  const findings = info.repoGuard.findings;
  console.log(
    '\n' +
      c.bold('Repo guard') +
      '  ' +
      info.repoGuard.guarded +
      ' folder(s) guarded; ' +
      (findings.length
        ? c.yellow(findings.length + ' change(s) neutralised:')
        : 'nothing from the sandbox needed neutralising'),
  );
  for (const f of findings.slice(-10)) console.log('  ' + c.yellow(safeText(f)));
  return 0;
}
