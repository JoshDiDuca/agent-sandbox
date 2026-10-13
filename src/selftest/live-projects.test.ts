// Live: the real session daemon + ptyhost with two projects at once. The launch folder (A) and a project in a root
// (B) each get two sessions requested at the same moment; each runs in its own folder with its own environment; B is
// set up once for both; viewers attach, detach and reattach, two at a time; exec and restart follow the project.
// Toolchain installers run as a dry run (no downloads); everything else is real. cmd.exe stands in for the agent.
import fs from 'node:fs';
import path from 'node:path';
import { projectSpec } from '../host/projects/index.js';
import { resizeFrame, type Endpoint } from '../shared/pty/index.js';
import { readJsonFile } from '../shared/io/index.js';
import { copyCmdAsFakeAgent, openViewer, sees, startDaemon, tail, viewersWhen, type Viewer } from './live.js';
import type { Suite } from './suite.js';

export const liveProjectsSuite: Suite = {
  name: 'live-projects',
  title: 'live: two projects, several sessions, several viewers',
  live: true,
  timeoutMs: 480000,
  run: async (t, f) => {
    const gen = await f.launch();
    const data = t.at('live-multi-data');
    const root = t.dir('live-root');
    const projB = t.dir('live-root', 'projB');
    copyCmdAsFakeAgent(data);
    const session = f.readJson(gen.sessionPath);
    // B's root appears at its own path here (like guestWorkspace "mirror"), so host and guest paths are the same.
    Object.assign(session, {
      workspace: f.workA,
      attach: { enabled: true },
      projectsDir: t.at('live-projects'),
      roots: [root],
      projectId: 'work-a',
    });
    Object.assign(session.harness, {
      arguments: ['/d', '/k', 'echo AGENT-READY'],
      resumeArguments: ['/d', '/k', 'echo AGENT-RESUMED'],
    });
    t.writeJson(gen.sessionPath, session);
    const local = t.at('live-multi-local');
    const daemon = startDaemon(t, f, {
      launchPath: gen.launchPath,
      data,
      workspace: f.workA,
      env: { AGENT_LOCAL_DIR: local, AGENT_DRY_RUN: '1', AGENT_MANAGED_DIR: t.at('live-managed') },
    });
    const viewers: Viewer[] = [];
    const view = async (attach: Endpoint | undefined, cols = 100): Promise<Viewer> => {
      const v = await openViewer(attach!, { cols });
      viewers.push(v);
      return v;
    };
    try {
      t.section('live: four sessions at once');
      const cfg = structuredClone(f.baseConfig);
      cfg.toolchains.environment = { LIVE_B: 'b-env' };
      const spec = projectSpec(
        await f.run({ cwd: projB, trustConfig: true }, cfg),
        { name: 'projB', host: projB, guest: projB, primary: false, mechanism: 'root', registeredAt: '' },
        false,
      );
      // All four at the same moment: two in the launch folder, two in B (whose setup they share).
      daemon.request({ kind: 'session', id: 'a1', harness: 'claude', args: [], cwd: f.workA });
      daemon.request({ kind: 'session', id: 'b1', harness: 'claude', args: [], cwd: projB, project: spec });
      daemon.request({ kind: 'session', id: 'b2', harness: 'claude', args: [], cwd: projB, project: spec });
      daemon.request({ kind: 'session', id: 'a2', harness: 'claude', args: [], cwd: f.workA });
      const [a1, a2, b1, b2] = await Promise.all(['a1', 'a2', 'b1', 'b2'].map((id) => daemon.started(id)));
      const all = [a1, a2, b1, b2];
      const notRunning = all.filter((s) => s?.phase !== 'running' || !s.attach);
      t.check(
        notRunning.length === 0,
        'four sessions requested at once all start (two per project)',
        notRunning.map((s) => s?.id + ': ' + s?.phase + ' ' + s?.message).join('\n') + '\n' + daemon.diagnostics(),
      );
      if (notRunning.length > 0) return;
      t.equal([a1!.project, b1!.project, b2!.project], ['work-a', 'projB', 'projB'], 'each session knows its project');
      const log = fs
        .readdirSync(path.join(data, 'logs'))
        .filter((n) => n.startsWith('daemon'))
        .map((n) => fs.readFileSync(path.join(data, 'logs', n), 'utf8'))
        .join('\n');
      t.equal(
        (log.match(/Project projB: setting up/g) ?? []).length,
        1,
        'two sessions for the same new project at once share one setup (no second provisioning run)',
      );
      t.equal(
        readJsonFile<{ phase: string }>(path.join(daemon.run, 'projects', 'projB.json'))?.phase,
        'ready',
        "the project's setup status is written for the host (sandbox status)",
      );

      t.section('live: each session has its own folder and environment');
      const views = await Promise.all(all.map((s) => view(s!.attach)));
      for (const v of views) await sees(t, v, 'AGENT-READY');
      for (const v of views) v.type('echo P=%AGENT_PROJECT% W=%AGENT_WORKSPACE% B=[%LIVE_B%]');
      const bSees = await sees(t, views[2], 'P=projB W=' + projB + ' B=[b-env]');
      t.check(
        Boolean(bSees),
        "B's first session runs with B's workspace, project and variables",
        tail(views[2].output()),
      );
      t.check(
        Boolean(await sees(t, views[3], 'B=[b-env]')),
        "B's second session runs with B's variables",
        tail(views[3].output()),
      );
      // (The daemon here runs without the boot's environment, so A's own AGENT_* variables are not set at all.)
      t.check(
        Boolean(await sees(t, views[0], 'B=[%LIVE_B%]')),
        "A's first session is untouched by B (B's variables never reach it)",
        tail(views[0].output()),
      );
      t.check(
        Boolean(await sees(t, views[1], 'B=[%LIVE_B%]')),
        "A's second session is untouched by B",
        tail(views[1].output()),
      );
      views[2].type('echo CWD=%CD%.');
      t.check(
        Boolean(await sees(t, views[2], 'CWD=' + projB + '.')),
        "B's session starts in B's folder",
        tail(views[2].output()),
      );

      t.section('live: several viewers on one session');
      const second = await view(b1!.attach, 60);
      const two = await viewersWhen(t, b1!.attach!, (v) => v.viewers === 2);
      t.check(two !== null, 'a second viewer attaches to the same session');
      second.socket.write(resizeFrame(90, 25));
      views[2].type('echo TWO-VIEWERS-OK');
      t.check(
        Boolean(await sees(t, views[2], 'TWO-VIEWERS-OK')),
        'the first viewer sees what it typed (after the second one resized)',
        tail(views[2].output()),
      );
      t.check(Boolean(await sees(t, second, 'TWO-VIEWERS-OK')), 'the second viewer sees it too', tail(second.output()));
      second.type('echo FROM-SECOND');
      t.check(
        Boolean(await sees(t, views[2], 'FROM-SECOND')),
        'input from the second viewer reaches the agent and the first viewer',
        tail(views[2].output()),
      );
      views[2].close();
      second.close();
      const none = await viewersWhen(t, b1!.attach!, (v) => v.viewers === 0);
      t.check(none !== null, 'closing every viewer is noticed');
      t.equal(daemon.status('b1')?.phase, 'running', 'closing every viewer never ends the session');
      for (let round = 1; round <= 3; round++) {
        const again = await view(b1!.attach);
        again.type('echo REATTACHED-' + round);
        t.check(
          Boolean(await sees(t, again, 'REATTACHED-' + round)),
          'reattach ' + round + ': a new viewer works on the same session',
          tail(again.output()),
        );
        again.close();
      }

      t.section('live: exec, restart and refusals follow the projects');
      daemon.request({ kind: 'exec', id: 'xb', command: ['echo', '%LIVE_B%'], cwd: projB, timeoutSeconds: 30 });
      daemon.request({ kind: 'exec', id: 'xa', command: ['echo', '[%LIVE_B%]'], cwd: f.workA, timeoutSeconds: 30 });
      const [xb, xa] = await Promise.all([daemon.response('xb'), daemon.response('xa')]);
      t.check(Boolean(xb?.stdout?.includes('b-env')), "exec in B's folder gets B's environment", JSON.stringify(xb));
      t.check(Boolean(xa?.stdout?.includes('[%LIVE_B%]')), "exec in A's folder gets A's", JSON.stringify(xa));
      daemon.request({
        kind: 'session',
        id: 'bad1',
        harness: 'claude',
        args: [],
        cwd: f.workB,
        project: { ...spec, name: 'outside', workspace: f.workB },
      });
      const bad = await daemon.started('bad1');
      t.check(
        bad?.phase === 'failed' && bad.message.includes('not visible inside the sandbox'),
        'a project outside the launch folder, the roots and C:\\Projects is refused',
        JSON.stringify(bad),
      );
      daemon.request({ kind: 'session', id: 'bad2', harness: 'claude', args: [], cwd: f.workA, project: spec });
      const claimed = await daemon.started('bad2');
      t.includes(
        claimed?.message ?? '',
        'not inside project projB',
        'a session cannot claim a project its folder is not in',
      );
      daemon.request({ kind: 'restart', id: 'rb', harness: null, cwd: projB });
      t.equal(
        (await daemon.response('rb'))?.message,
        'restarted 2 session(s)',
        'restart scoped to a project restarts only its sessions',
      );
      t.check(fs.existsSync(path.join(local, 'projects', 'projB', 'shell.cmd')), 'sbx-shell projB has a shell script');
      t.includes(
        fs.readFileSync(path.join(local, 'projects', 'projB', 'env.cmd'), 'utf8'),
        'LIVE_B=b-env',
        "sbx-shell projB opens with B's environment",
      );
      t.check(fs.existsSync(path.join(local, 'bin', 'sbx-shell.cmd')), "sbx-shell is on the sandbox's PATH");
    } finally {
      for (const v of viewers) v.close();
      // End every agent: a fresh viewer types exit into each still-running session.
      for (const id of ['a1', 'a2', 'b1', 'b2']) {
        const s = daemon.status(id);
        if (s?.phase !== 'running' || !s.attach) continue;
        try {
          const v = await openViewer(s.attach);
          v.type('exit');
          await t.waitFor(() => v.exitCode() !== null, 10000);
          v.close();
        } catch {
          /* already gone */
        }
      }
      await daemon.stop();
    }
  },
};
