// Live: the real guest session daemon + ptyhost (ConPTY), driven through the run folder exactly like the host does,
// with cmd.exe standing in for the agent. One daemon serves all the checks below, in order (compiling ptyhost is slow).
import fs from 'node:fs';
import path from 'node:path';
import { queryViewers } from '../shared/pty/index.js';
import { copyCmdAsFakeAgent, openViewer, sees, startDaemon, tail, viewersWhen, WAIT } from './support/live.js';
import type { Suite } from './support/suite.js';

export const liveDaemonSuite: Suite = {
  name: 'live-daemon',
  title: 'live: session daemon + ptyhost (start, attach, viewers, exec, restart, exit)',
  live: true,
  timeoutMs: 360000,
  run: async (t, f) => {
    const gen = await f.launch();
    const data = t.at('live-data');
    const workspace = f.workA;
    copyCmdAsFakeAgent(data);
    const session = f.readJson(gen.sessionPath);
    Object.assign(session, { workspace, attach: { enabled: true } });
    Object.assign(session.harness, {
      arguments: ['/d', '/k', 'echo LIVE-AGENT-READY'],
      resumeArguments: ['/d', '/k', 'echo LIVE-AGENT-RESUMED'],
    });
    t.writeJson(gen.sessionPath, session);
    const daemon = startDaemon(t, f, { launchPath: gen.launchPath, data, workspace });
    const viewers = [] as { close: () => void }[];
    try {
      t.section('live: starting a session');
      daemon.request({ kind: 'session', id: 'live1', harness: 'claude', args: [], cwd: workspace });
      const started = await daemon.started('live1');
      const running = started?.phase === 'running' && Boolean(started.attach?.port);
      t.check(
        running,
        'the daemon compiles ptyhost and starts a session on request',
        'phase: ' + started?.phase + ' ' + (started?.message ?? '(no status written)') + '\n' + daemon.diagnostics(),
      );
      if (!started?.attach) return;
      const attach = started.attach;
      const local = { ...attach, addresses: ['127.0.0.1'] };

      t.section('live: attached clients');
      const viewer = await openViewer(attach);
      viewers.push(viewer);
      const sawReady = await sees(t, viewer, 'LIVE-AGENT-READY');
      t.check(
        Boolean(sawReady),
        "an attached client sees the agent's screen",
        'screen so far: ' + tail(viewer.output()) + '\n' + daemon.diagnostics(),
      );
      viewer.type('echo TYPED-%USERNAME:~0,0%OK');
      const sawTyped = await sees(t, viewer, 'TYPED-OK');
      t.check(Boolean(sawTyped), 'keystrokes reach the agent', 'screen so far: ' + tail(viewer.output()));

      const intruder = await openViewer(attach, { token: 'wrong-token', cols: 80, rows: 24 });
      viewers.push(intruder);
      const denied = await t.waitFor(() => intruder.error(), WAIT.viewers);
      t.check(
        Boolean(denied) && denied!.includes('denied'),
        'a client with the wrong token is refused',
        'error frame: ' + JSON.stringify(denied) + ', connection closed: ' + intruder.closed(),
      );
      t.check(
        !intruder.output().includes('LIVE-AGENT'),
        'a client with the wrong token sees nothing of the session',
        tail(intruder.output()),
      );

      t.section('live: counting viewers');
      // Each count is polled: a query that gets no answer yet is asked again, and the number must settle on the
      // expected value.
      const one = await viewersWhen(t, attach, (v) => v.viewers === 1);
      t.check(
        one !== null,
        'a single attached terminal is counted as one viewer',
        'last answer: ' + JSON.stringify(await queryViewers(local, 5000)),
      );
      t.equal(one?.remote, 0, 'a viewer on loopback (inside the sandbox) is not counted as remote');
      const second = await openViewer(attach, { cols: 60, rows: 20 });
      viewers.push(second);
      const two = await viewersWhen(t, attach, (v) => v.viewers === 2);
      t.check(
        two !== null,
        'a second attached terminal is counted too',
        'last answer: ' + JSON.stringify(await queryViewers(local, 5000)),
      );
      second.close();
      const backToOne = await viewersWhen(t, attach, (v) => v.viewers === 1);
      t.check(
        backToOne !== null,
        'a closed terminal stops counting at once',
        'last answer: ' + JSON.stringify(await queryViewers(local, 5000)),
      );
      t.equal(backToOne?.remote, 0, 'the remaining viewer is still not remote');
      t.equal(daemon.status('live1')?.phase, 'running', 'the session keeps running when a terminal closes');
      t.equal(
        await queryViewers({ ...local, token: 'wrong-token' }, 10000),
        null,
        'the viewer query needs the session token too',
      );

      t.section('live: exec and requests');
      daemon.request({
        kind: 'exec',
        id: 'exec1',
        command: ['echo', 'hello from exec'],
        cwd: workspace,
        timeoutSeconds: 30,
      });
      const exec = await daemon.response('exec1');
      t.check(
        Boolean(exec?.ok && exec.stdout?.includes('hello from exec')),
        'exec runs a command in the sandbox and returns its output',
        JSON.stringify(exec),
      );
      daemon.request({ kind: 'exec', id: 'exec2', command: ['dir'], cwd: 'C:\\Windows', timeoutSeconds: 30 });
      const outside = await daemon.response('exec2');
      t.check(
        outside?.ok === false && outside.message.includes('not inside the sandbox workspace'),
        'exec refuses folders outside the workspace',
        JSON.stringify(outside),
      );
      daemon.request({ kind: 'shell', id: 'evil', command: 'calc' });
      daemon.request({ kind: 'ping', id: 'ping1' });
      const ping = await daemon.response('ping1');
      t.check(Boolean(ping?.ok), 'ping is answered', JSON.stringify(ping));
      // Requests are handled in order, so by the time the ping is answered the unknown one has been dealt with.
      t.check(
        !fs.existsSync(path.join(daemon.run, 'responses', 'evil.json')),
        'an unknown request kind gets no answer...',
      );
      t.check(!fs.existsSync(path.join(daemon.run, 'requests', 'evil.json')), '... and is deleted');

      t.section('live: restart and exit');
      daemon.request({ kind: 'restart', id: 'restart1', harness: 'claude' });
      const sawResumed = await sees(t, viewer, 'LIVE-AGENT-RESUMED');
      t.check(
        Boolean(sawResumed),
        'restart relaunches the agent with its resume arguments while attached',
        'screen so far: ' + tail(viewer.output()) + '\n' + daemon.diagnostics(),
      );
      viewer.type('exit 3');
      const gotExit = await t.waitFor(() => viewer.exitCode() !== null, WAIT.exit);
      const ended = await t.waitFor(() => {
        const s = daemon.status('live1');
        return s?.phase === 'exited' ? s : null;
      }, WAIT.exit);
      t.equal(gotExit ? viewer.exitCode() : null, 3, "the agent's exit code reaches the attached client");
      t.equal(ended?.exitCode, 3, "the agent's exit code reaches the session status");
    } finally {
      for (const v of viewers) v.close();
      await daemon.stop();
    }
  },
};
