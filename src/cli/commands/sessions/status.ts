import _ from 'lodash';
import { AccountStore } from '../../../host/profile/index.js';
import { SandboxChannel } from '../../../host/channel/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { ProjectRegistry } from '../../../host/projects/index.js';
import { RepoGuardStore } from '../../../host/guard/index.js';
import { projectForGuestDir } from '../../../shared/paths/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import { watcherRunning } from '../../../sync/index.js';
import { errMsg, safeText } from '../../../core/util/index.js';
import { printJson, table, ago, c, shortenMiddle, termWidth } from '../../output/index.js';
import { type Context } from '../context.js';
import { hereDir, locateHere } from '../projects/index.js';
import { listedSessions, viewerText } from './list.js';

/** Running databases by port, from the sandbox's own `sbx-db list` (best effort: unknown when it does not answer). */
async function runningPorts(ctx: Context, cwd: string): Promise<Set<number> | null> {
  try {
    const r = await new SandboxChannel(ctx.dataPath).exec(['sbx-db', 'list'], cwd, 30);
    return new Set(
      (r.stdout ?? '')
        .split(/\r?\n/)
        .filter((l) => /\brunning\b/.test(l))
        .map((l) => Number(/port (\d+)/.exec(l)?.[1]))
        .filter((n) => n > 0),
    );
  } catch {
    return null;
  }
}

export async function status(ctx: Context): Promise<number> {
  const running = isSandboxRunning();
  const sandbox = new RunDir(ctx.dataPath).readSandboxStatus();
  const registry = running ? new ProjectRegistry(ctx.storageRoot).read() : null;
  const ready = running && sandbox?.phase === 'ready';
  const daemon = ready
    ? await new SandboxChannel(ctx.dataPath).ping().then(
        (r) => r.message,
        (e: unknown) => 'no answer (' + errMsg(e) + ')',
      )
    : '-';
  const here = running ? locateHere(ctx, sandbox) : { project: null, guestDir: null };
  const sessionList = running ? await listedSessions(ctx) : [];
  const provisioning = running ? new RunDir(ctx.dataPath).listProjectStatus() : [];
  const ports = ready && sandbox ? await runningPorts(ctx, sandbox.guestWorkspace) : null;
  const findings = new RepoGuardStore(ctx.dataPath).findings();
  const startedAt = Number(/^(\d+)-/.exec(registry?.launchId ?? sandbox?.launchId ?? '')?.[1]) || null;
  const projects = (registry?.projects ?? []).map((p) => {
    const prov = provisioning.find((s) => s.name.toLowerCase() === p.name.toLowerCase());
    const own = sessionList.filter(
      (s) => s.phase === 'running' && projectForGuestDir(registry?.projects ?? [], s.cwd)?.name === p.name,
    );
    return {
      name: p.name,
      host: p.host,
      guest: p.guest,
      mechanism: p.mechanism,
      here: here.project?.name === p.name,
      setup: prov
        ? { phase: prov.phase, message: safeText(prov.message) }
        : { phase: 'not set up yet', message: 'set up when you first start a session or command there' },
      databases: (prov?.databases ?? []).map((d) => ({
        database: safeText(d.database),
        port: d.port,
        state: ports ? (ports.has(d.port) ? 'running' : 'stopped') : 'unknown',
      })),
      sessions: own.map((s) => ({
        id: s.id,
        harness: safeText(s.harness),
        viewers: viewerText(s.viewers),
        started: s.startedAt,
      })),
      // With several guarded folders each finding starts with its folder.
      repoGuard: findings
        .filter((f) => f.detail.toLowerCase().startsWith(p.host.toLowerCase() + ':'))
        .map((f) => f.kind + ': ' + safeText(f.detail)),
    };
  });
  const info = {
    sandbox: {
      running,
      phase: running ? (sandbox?.phase ?? 'unknown') : 'stopped',
      message: sandbox?.message,
      headless: sandbox?.headless,
      uptime: running && startedAt ? ago(startedAt).replace(' ago', '') : null,
      daemon,
      account: new AccountStore(ctx.storageRoot).activeFor(ctx.dataPath),
      syncWatcher: watcherRunning(ctx.dataPath),
    },
    here: { folder: hereDir(ctx), project: here.project?.name ?? null, guest: here.guestDir },
    roots: registry?.roots ?? [],
    projects,
    otherSessions: sessionList
      .filter((s) => s.phase === 'running' && !projects.some((p) => p.sessions.some((x) => x.id === s.id)))
      .map((s) => ({ id: s.id, harness: safeText(s.harness), cwd: safeText(s.cwd) })),
    repoGuard: {
      guarded: new RepoGuardStore(ctx.dataPath).guarded().length,
      findings: findings.map((f) => f.kind + ': ' + f.detail),
    },
  };
  if (printJson(ctx, info)) return 0;
  const yesNo = (v: unknown): string => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v ?? '-'));
  table(Object.entries(info.sandbox).map(([k, v]) => [_.startCase(k), safeText(yesNo(v))]));
  if (!running) return 0;
  console.log(
    '\n' +
      c.bold('Projects') +
      c.dim('  (* = this folder: ' + info.here.folder + (info.here.project ? '' : ', not in this sandbox') + ')'),
  );
  for (const p of projects) {
    console.log(
      (p.here ? '* ' : '  ') +
        c.bold(p.name) +
        '  ' +
        p.host +
        '  ->  ' +
        p.guest +
        c.dim(
          '  (' +
            (p.mechanism === 'launch'
              ? 'started from here'
              : p.mechanism === 'root'
                ? 'in a project root'
                : p.mechanism === 'boot'
                  ? 'mapped at start'
                  : 'wsb share') +
            ')',
        ),
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
  for (const r of info.roots)
    console.log('  root  ' + r.host + '  ->  ' + r.guest + c.dim('  (every project in it opens without a restart)'));
  for (const s of info.otherSessions) console.log('  session ' + s.id + '  ' + s.harness + '  ' + s.cwd);
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
  for (const f of info.repoGuard.findings.slice(-10)) console.log('  ' + c.yellow(safeText(f)));
  return 0;
}
