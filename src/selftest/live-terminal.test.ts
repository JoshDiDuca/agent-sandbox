// Live: the terminal path as you use it. An outer ptyhost stands in for Windows Terminal (it hosts the console, like
// Windows Terminal's own pseudo console) and runs the real viewer/attach client (runTerminalClient), which is attached
// to an inner ptyhost running a stand-in agent. The agent turns SGR mouse tracking on and echoes every byte it reads.
// Checks: clicks and the wheel reach the agent, Backspace stays Backspace, a split escape sequence arrives whole,
// 500 printed lines scroll through as lines (no alternate screen, no scrollback clear), and a viewer that joins after
// a screen clear still gets mouse tracking.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { encodeFrame, FrameType } from '../shared/pty/index.js';
import { CSC, openViewer, tail, WAIT, type Viewer } from './support/live.js';
import type { Suite } from './support/suite.js';

/** The stand-in agent: VT input and SGR mouse tracking on, echoes what it reads ("got <1b>[<0;10;5M"). L prints 500 lines, K clears the screen, q quits. */
const AGENT_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
static class MouseAgent
{
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint m);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint m);
    [DllImport("kernel32.dll")] static extern bool ReadFile(IntPtr h, byte[] b, int n, out int read, IntPtr o);
    static void Say(string s) { Console.Out.Write(s); Console.Out.Flush(); }
    static int Main()
    {
        IntPtr input = GetStdHandle(-10), output = GetStdHandle(-11);
        uint mode;
        GetConsoleMode(output, out mode); SetConsoleMode(output, mode | 4);
        SetConsoleMode(input, 0x200);
        Say("\x1b[?1000h\x1b[?1006hAGENT-READY\r\n");
        var buffer = new byte[512];
        int n;
        while (ReadFile(input, buffer, buffer.Length, out n, IntPtr.Zero) && n > 0)
        {
            var text = new StringBuilder();
            for (int i = 0; i < n; i++) text.Append(buffer[i] < 32 || buffer[i] > 126 ? "<" + buffer[i].ToString("x2") + ">" : ((char)buffer[i]).ToString());
            string got = text.ToString();
            Say("got " + got + "\r\n");
            if (got == "L") { var lines = new StringBuilder(); for (int i = 1; i <= 500; i++) lines.Append("line " + i + "\r\n"); Say(lines.ToString() + "LINES-DONE\r\n"); }
            if (got == "K") Say("\x1b[2J\x1b[HCLEARED\r\n");
            if (got == "q") break;
        }
        // Exits with mouse tracking still on (like a crash): the client must turn it off.
        return 0;
    }
}
`;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

const compile = (source: string, exe: string): string => {
  const result = spawnSync(CSC, ['/nologo', '/optimize', '/target:exe', '/out:' + exe, source], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0
    ? ''
    : ((result.stdout ?? '') + (result.stderr ?? '')).trim().slice(0, 1500) || 'csc failed';
};

/** conpty.dll as a sandbox has it (C:\AgentData\tools\conpty), when this machine has one; else only Windows' own is tested. */
const conptyDll = (): string | null => {
  const dll = path.join(process.env.AGENT_DATA_DIR ?? 'C:\\AgentData', 'tools', 'conpty', 'conpty.dll');
  return fs.existsSync(dll) && fs.existsSync(path.join(path.dirname(dll), 'OpenConsole.exe')) ? dll : null;
};

export const liveTerminalSuite: Suite = {
  name: 'live-terminal',
  title: 'live: the viewer/attach client in a terminal (mouse clicks and wheel, keys, scrolling lines, late viewers)',
  live: true,
  timeoutMs: 300000,
  run: async (t) => {
    const ptyhost = t.at('ptyhost.exe');
    const agent = t.at('mouse-agent.exe');
    fs.writeFileSync(t.at('mouse-agent.cs'), AGENT_CS);
    const errors =
      compile(path.join(t.packageRoot, 'sandbox', 'csharp', 'PtyHost.cs'), ptyhost) ||
      compile(t.at('mouse-agent.cs'), agent);
    t.check(!errors, 'ptyhost and the stand-in agent compile', errors);
    if (errors) return;
    const client = t.at('client.mjs');
    fs.writeFileSync(
      client,
      [
        'import { connect, runTerminalClient } from ' +
          JSON.stringify(pathToFileURL(path.join(t.packageRoot, 'dist', 'shared', 'pty', 'index.js')).href) +
          ';',
        'const socket = await connect({ addresses: ["127.0.0.1"], port: Number(process.argv[2]), token: "tok" });',
        'const result = await runTerminalClient(socket, "tok");',
        'console.log("CLIENT-DONE " + result.reason);',
      ].join('\n'),
    );

    const dll = conptyDll();
    const kinds: (string | null)[] = dll ? [dll, null] : [null];
    if (!dll) t.skip("conpty.dll not found on this machine: only Windows' own pseudo console is tested");
    for (const kind of kinds) {
      const label = kind ? 'conpty.dll' : "Windows' pseudo console";
      t.section('live terminal (' + label + ')');
      const children: ChildProcess[] = [];
      const viewers: Viewer[] = [];
      const start = (port: number, command: string, log: string): void => {
        const env: NodeJS.ProcessEnv = { ...process.env, PTYHOST_BIND: 'loopback' };
        delete env.PTYHOST_CONPTY;
        if (kind) env.PTYHOST_CONPTY = kind;
        children.push(
          spawn(ptyhost, [String(port), 'tok', '100', '30', t.at(log), command], {
            env,
            stdio: 'ignore',
            windowsHide: true,
          }),
        );
      };
      try {
        const innerPort = await freePort();
        start(innerPort, '"' + agent + '"', 'inner-' + kinds.indexOf(kind) + '.log');
        const outerPort = await freePort();
        start(
          outerPort,
          '"' + process.execPath + '" "' + client + '" ' + innerPort,
          'outer-' + kinds.indexOf(kind) + '.log',
        );
        // The terminal: what it shows is what the client wrote; what it types goes to the client's console.
        const terminal = await openViewer({ addresses: ['127.0.0.1'], port: outerPort, token: 'tok' });
        viewers.push(terminal);
        const screen = (): string => terminal.output();
        const send = (text: string): void => {
          terminal.socket.write(encodeFrame(FrameType.Input, Buffer.from(text, 'latin1')));
        };
        const ready = await t.waitFor(() => screen().includes('AGENT-READY'), WAIT.screen);
        t.check(Boolean(ready), 'the client shows the agent', 'screen: ' + tail(screen()));
        if (!ready) continue;

        // The client switches its console to pass the terminal's input through as it is; until then clicks are lost.
        const click = '\x1b[<0;10;5M\x1b[<0;10;5m';
        const clicked = await t.waitFor(
          () => {
            if (!screen().includes('got <1b>[<0;10;5M')) send(click);
            return screen().includes('got <1b>[<0;10;5M');
          },
          WAIT.screen,
          1000,
        );
        t.check(
          Boolean(clicked),
          'a mouse click in the terminal reaches the agent (SGR mouse report)',
          'screen: ' + tail(screen(), 800),
        );
        const mark = screen().length;
        const after = (): string => screen().slice(mark);
        send('\x1b[<64;10;5M');
        t.check(
          Boolean(await t.waitFor(() => after().includes('got <1b>[<64;10;5M'), WAIT.screen)),
          'the mouse wheel reaches the agent while it tracks the mouse',
          'screen: ' + tail(after(), 800),
        );
        send('\x7f');
        t.check(
          Boolean(await t.waitFor(() => after().includes('got <7f>'), WAIT.screen)),
          'Backspace reaches the agent as DEL (one character, not a word)',
          'screen: ' + tail(after(), 800),
        );
        send('\x08');
        t.check(
          Boolean(await t.waitFor(() => after().includes('got <08>'), WAIT.screen)),
          'Ctrl+Backspace reaches the agent as ^H',
          'screen: ' + tail(after(), 800),
        );
        send('\x1b[');
        await new Promise((r) => setTimeout(r, 5));
        send('C');
        t.check(
          Boolean(await t.waitFor(() => after().includes('got <1b>[C'), WAIT.screen)),
          'a Right arrow that reaches the client in two pieces arrives whole (no stray "C")',
          'screen: ' + tail(after(), 800),
        );

        const before = screen().length;
        send('L');
        const done = await t.waitFor(() => screen().includes('LINES-DONE'), WAIT.screen);
        const printed = screen().slice(before);
        const seen = new Set([...printed.matchAll(/line (\d+)\b/g)].map((m) => Number(m[1])));
        const missing = Array.from({ length: 500 }, (_, i) => i + 1)
          .filter((n) => !seen.has(n))
          .map((n) => 'line ' + n);
        t.check(
          Boolean(done) && missing.length === 0,
          'all 500 printed lines reach the terminal as lines',
          'missing: ' + missing.slice(0, 10).join(', ') + '\n' + tail(printed),
        );
        // (The client clears the tab once when it starts; from then on nothing may take the scrollback away.)
        const session = screen().slice(screen().indexOf('AGENT-READY'));
        for (const [sequence, what] of [
          ['\x1b[?1049h', 'alternate screen'],
          ['\x1b[?47h', 'alternate screen (47)'],
          ['\x1b[?1047h', 'alternate screen (1047)'],
          ['\x1b[3J', 'clear scrollback'],
        ]) {
          t.excludes(session, sequence, 'the terminal is never sent ' + what + ' (' + JSON.stringify(sequence) + ')');
        }

        if (kind) {
          // A viewer that joins after the agent cleared its screen: the replay starts at the clear, the modes come first.
          send('K');
          await t.waitFor(() => screen().includes('CLEARED'), WAIT.screen);
          const late = await openViewer({ addresses: ['127.0.0.1'], port: innerPort, token: 'tok' });
          viewers.push(late);
          await t.waitFor(() => late.output().includes('CLEARED'), WAIT.screen);
          const head = late.output().slice(0, late.output().indexOf('CLEARED'));
          t.check(
            head.includes('\x1b[?1000h') && head.includes('\x1b[?1006h'),
            "a viewer joining after a screen clear gets the agent's mouse tracking before the replay",
            'late viewer: ' + JSON.stringify(late.output().slice(0, 300)),
          );
          late.close();
        }

        send('q');
        const ended = await t.waitFor(() => screen().includes('CLIENT-DONE'), WAIT.exit);
        t.check(Boolean(ended), 'the client ends with the agent', 'screen: ' + tail(screen()));
        if (kind)
          t.includes(
            screen().slice(screen().lastIndexOf('got q')),
            '\x1b[?1000l',
            'leaving the session turns mouse tracking off in the terminal again',
          );
      } finally {
        for (const v of viewers) v.close();
        for (const c of children) if (c.exitCode === null) c.kill();
      }
    }
  },
};
