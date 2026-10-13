// The sandbox's own proxy for network.allowOnly (runs detached for the sandbox's life, as sbx-netproxy.exe so the
// firewall can let only it out). HTTPS goes through CONNECT, plain HTTP as proxy requests; a host that is not allowed
// gets 403 and a line in logs\netproxy.log. With network.proxy set it hands everything on to that proxy.
// Usage: sbx-netproxy.exe netproxy.js
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { expandAllowList, hostAllowed, PROXY_PORT } from '../shared/network/policy.js';
import { logsDir, session } from './env.js';

const allowed = expandAllowList(session.network.allowOnly ?? []);
const upstream = session.network.proxy ? new URL(session.network.proxy) : null;
const logFile = path.join(logsDir, 'netproxy.log');
let logged = 0;
/** Refusals, capped: a program retrying in a loop must not fill the disk. */
const refuse = (host: string): void => {
  if (logged++ > 5000) return;
  try {
    fs.appendFileSync(logFile, new Date().toISOString() + ' blocked ' + host + '\n');
  } catch {
    /* ignore */
  }
};

/** Opens a TCP tunnel to host:port, directly or through the upstream proxy (CONNECT). */
const tunnel = (host: string, port: number, onReady: (socket: net.Socket) => void, onError: () => void): void => {
  if (!upstream) {
    const socket = net.connect(port, host, () => onReady(socket));
    socket.once('error', onError);
    return;
  }
  const socket = net.connect(Number(upstream.port || 80), upstream.hostname, () =>
    socket.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\n\r\n'),
  );
  socket.once('error', onError);
  let head = '';
  const onData = (chunk: Buffer): void => {
    head += chunk.toString('latin1');
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) {
      if (head.length > 16384) {
        socket.destroy();
        onError();
      }
      return;
    }
    socket.off('data', onData);
    if (!/^HTTP\/1\.\d 200/.test(head)) {
      socket.destroy();
      onError();
      return;
    }
    const rest = Buffer.from(head.slice(end + 4), 'latin1');
    if (rest.length) socket.unshift(rest);
    onReady(socket);
  };
  socket.on('data', onData);
};

const server = http.createServer((req, res) => {
  // Plain HTTP: the request line has the full URL.
  let target: URL;
  try {
    target = new URL(req.url ?? '');
  } catch {
    res.writeHead(400).end('bad proxy request');
    return;
  }
  if (!hostAllowed(target.hostname, allowed)) {
    refuse(target.hostname);
    res
      .writeHead(403, { 'Content-Type': 'text/plain' })
      .end('Blocked by the sandbox (network.allowOnly): ' + target.hostname + '\n');
    return;
  }
  const options: http.RequestOptions = upstream
    ? {
        host: upstream.hostname,
        port: Number(upstream.port || 80),
        path: target.href,
        method: req.method,
        headers: req.headers,
      }
    : {
        host: target.hostname,
        port: Number(target.port || 80),
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
      };
  const out = http.request(options, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  out.on('error', () => {
    if (!res.headersSent) res.writeHead(502).end('upstream error');
    else res.destroy();
  });
  req.pipe(out);
});

server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
  const [host, portText] = (req.url ?? '').split(/:(?=\d+$)/);
  const port = Number(portText || 443);
  client.on('error', () => client.destroy());
  if (!host || !(port > 0 && port < 65536) || !hostAllowed(host, allowed)) {
    refuse(host ?? '?');
    client.end(
      'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nBlocked by the sandbox (network.allowOnly): ' +
        host +
        '\n',
    );
    return;
  }
  tunnel(
    host,
    port,
    (remote) => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      remote.pipe(client);
      client.pipe(remote);
      remote.on('error', () => client.destroy());
    },
    () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'),
  );
});

server.listen(PROXY_PORT, '127.0.0.1');
