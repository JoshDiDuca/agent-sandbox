// Live: the sandbox's allowOnly proxy (the real bundled runtime\netproxy.js) and the PC-side port forwarder, on
// loopback only; and that the cargo shim compiles with the compiler that ships with Windows.
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startPortForwards } from '../host/network/index.js';
import { PROXY_PORT, relayPort } from '../shared/network/index.js';
import { CSC } from './support/live.js';
import type { Suite } from './support/suite.js';

/** A TCP server that answers every line with "echo:<line>". */
const echoServer = (port = 0): Promise<net.Server> =>
  new Promise((resolve) => {
    const server = net.createServer((s) => s.on('data', (d) => s.write('echo:' + d.toString())));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
const portOf = (server: net.Server): number => (server.address() as net.AddressInfo).port;

/** Sends `text` after `preamble` (a CONNECT) and resolves with everything received within a short while. */
const talk = (port: number, preamble: string, text: string): Promise<string> =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let got = '';
    socket.on('data', (d) => {
      got += d.toString();
      if (preamble && got.includes('\r\n\r\n') && got.startsWith('HTTP/1.1 200') && !got.includes('echo:'))
        socket.write(text);
    });
    socket.on('error', () => resolve(got));
    socket.on('connect', () => socket.write(preamble || text));
    setTimeout(() => {
      socket.destroy();
      resolve(got);
    }, 1500);
  });

export const liveNetworkSuite: Suite = {
  name: 'live-network',
  title: 'live: allowOnly proxy, port forwarding, cargo shim',
  live: true,
  run: async (t, f) => {
    t.section('allowOnly proxy');
    const gen = await f.launch(
      {},
      { config: { ...f.baseConfig, network: { ...f.baseConfig.network, allowOnly: ['localhost'] } } },
    );
    const echo = await echoServer();
    const proxy = spawn(process.execPath, [path.join(gen.launchPath, 'runtime', 'netproxy.js')], {
      env: { ...process.env, AGENT_LAUNCH_DIR: gen.launchPath, AGENT_DATA_DIR: t.dir('netproxy-data') },
      stdio: 'ignore',
    });
    try {
      const up = await t.waitFor(
        () =>
          new Promise<boolean>((resolve) => {
            const s = net.connect(PROXY_PORT, '127.0.0.1', () => {
              s.destroy();
              resolve(true);
            });
            s.on('error', () => resolve(false));
          }),
        10000,
        200,
      );
      t.check(Boolean(up), 'the proxy listens on localhost');
      const allowed = await talk(
        PROXY_PORT,
        'CONNECT localhost:' + portOf(echo) + ' HTTP/1.1\r\nHost: localhost\r\n\r\n',
        'hi',
      );
      t.check(
        allowed.startsWith('HTTP/1.1 200') && allowed.includes('echo:hi'),
        'an allowed host is tunnelled through',
        allowed,
      );
      const blocked = await talk(PROXY_PORT, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n', '');
      t.check(blocked.startsWith('HTTP/1.1 403'), 'any other host is refused (403)', blocked);
    } finally {
      proxy.kill();
      echo.close();
    }

    t.section('port forwarding');
    const relay = await echoServer(relayPort(0));
    const free = await echoServer();
    const pcPort = portOf(free);
    free.close();
    await new Promise((r) => setTimeout(r, 200));
    const stop = startPortForwards([{ pc: pcPort, sandbox: 3000 }], () => '127.0.0.1');
    await new Promise((r) => setTimeout(r, 300));
    const forwarded = await talk(pcPort, '', 'ping');
    stop();
    relay.close();
    t.equal(forwarded, 'echo:ping', "localhost:<pc> on this PC reaches the sandbox's relay");

    t.section('cargo shim');
    const out = path.join(t.dir('cargoshim'), 'cargo.exe');
    const compiled = spawnSync(
      CSC,
      ['/nologo', '/optimize', '/out:' + out, path.join(gen.launchPath, 'sandbox', 'cargoshim.cs')],
      { encoding: 'utf8' },
    );
    t.check(
      compiled.status === 0,
      'cargoshim.cs compiles with the .NET Framework compiler (C# 5)',
      compiled.stdout + compiled.stderr,
    );
  },
};
