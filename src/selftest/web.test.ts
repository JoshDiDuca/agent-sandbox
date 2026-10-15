// The web UI's server: login and cookie, the Host / Origin / CSRF checks, static files that cannot leave their folder,
// sessions without tokens, and the terminal bridge against a fake ptyhost on loopback (the real address check is the
// backend's, so the fake is only reachable here).
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { webSession } from '../cli/services/index.js';
import type { SessionStatus } from '../core/types.js';
import {
  cookieValue,
  csrfOk,
  hostAllowed,
  originAllowed,
  sameSecret,
  StaticFiles,
  WebAuth,
  WebServer,
  WebStore,
  type WebBackend,
} from '../host/web/index.js';
import { encodeFrame, FrameReader, FrameType, type Endpoint } from '../shared/pty/index.js';
import { CSRF_HEADER, CSRF_VALUE, parseClientMessage, type WebSession } from '../shared/web/index.js';
import type { Suite } from './support/suite.js';

const TOKEN = 'a'.repeat(64);
const ATTACH_TOKEN = 'SECRET-ATTACH-TOKEN';

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** One HTTP request with exactly the headers given (Host included). */
function send(
  port: number,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: { Host: '127.0.0.1:' + port, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** A ptyhost stand-in: records what the bridge sends, plays output, ends with EXIT when it gets the letter x. */
class FakePtyHost {
  readonly hellos: Buffer[] = [];
  readonly inputs: Buffer[] = [];
  readonly resizes: Buffer[] = [];
  pings = 0;
  closed = 0;
  private readonly server: net.Server;
  private readonly open = new Set<net.Socket>();
  port = 0;

  constructor() {
    this.server = net.createServer((socket) => {
      this.open.add(socket);
      const reader = new FrameReader();
      socket.on('error', () => undefined);
      socket.on('close', () => this.closed++);
      socket.on('data', (chunk) => {
        for (const frame of reader.push(chunk)) {
          if (frame.type === FrameType.Hello) {
            this.hellos.push(frame.payload);
            // Output with a clipboard write (OSC 52) inside: the bridge must drop that part.
            socket.write(encodeFrame(FrameType.Output, Buffer.from('hello \x1b]52;c;ZXZpbA==\x07world')));
          } else if (frame.type === FrameType.Input) {
            this.inputs.push(frame.payload);
            if (frame.payload.toString() === 'x') {
              const code = Buffer.alloc(4);
              code.writeInt32LE(3, 0);
              socket.write(encodeFrame(FrameType.Exit, code));
            }
          } else if (frame.type === FrameType.Resize) this.resizes.push(frame.payload);
          else if (frame.type === FrameType.Ping) this.pings++;
        }
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) =>
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve();
      }),
    );
  }

  stop(): void {
    this.server.close();
    for (const socket of this.open) socket.destroy();
  }
}

/** What a browser tab sees on the terminal socket. */
class Tab {
  readonly texts: string[] = [];
  readonly binary: Buffer[] = [];
  closeCode: number | null = null;
  opened = false;
  failed = false;
  readonly socket: WebSocket;

  constructor(url: string, headers: Record<string, string>) {
    this.socket = new WebSocket(url, { headers });
    this.socket.on('open', () => (this.opened = true));
    this.socket.on('unexpected-response', () => (this.failed = true));
    this.socket.on('error', () => (this.failed = true));
    this.socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.binary.push(data);
      else this.texts.push(data.toString('utf8'));
    });
    this.socket.on('close', (code: number) => (this.closeCode = code));
  }
}

const session = (id: string, attach?: SessionStatus['attach']): SessionStatus => ({
  id,
  launchId: 'launch1',
  harness: 'claude',
  cwd: 'C:\\Projects\\app',
  phase: 'running',
  message: 'running\x1b[31m',
  updatedAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:00:00.000Z',
  ...(attach ? { attach } : {}),
});

export const webSuite: Suite = {
  name: 'web',
  title: 'web UI server: login, Host / Origin / CSRF checks, static files, sessions, terminal bridge',
  run: async (t) => {
    t.section('the token and the cookie');
    t.check(
      sameSecret(TOKEN, TOKEN) && !sameSecret(TOKEN, 'b'.repeat(64)) && !sameSecret(TOKEN, ''),
      'secrets compare',
    );
    let clock = 1000;
    const auth = new WebAuth(TOKEN, () => clock);
    const bad = auth.login('nope');
    t.check(!bad.ok && bad.status === 401, 'a wrong token is refused');
    t.check(!auth.login(42).ok && !auth.login({}).ok, 'a token that is not text is refused');
    const good = auth.login(TOKEN);
    t.check(good.ok, 'the right token logs in');
    const cookie = good.ok ? good.cookie : '';
    t.check(auth.signedIn('x=1; sbxweb=' + cookie), 'the cookie signs in');
    t.check(
      !auth.signedIn('sbxweb=' + cookie.replace(/.$/, '0')) && !auth.signedIn(undefined),
      'another cookie does not',
    );
    clock += 13 * 60 * 60 * 1000;
    t.check(!auth.signedIn('sbxweb=' + cookie), 'a cookie unused for 12 hours expires');
    const limited = new WebAuth(TOKEN, () => clock);
    for (let i = 0; i < 8; i++) limited.login('wrong');
    const locked = limited.login(TOKEN);
    t.check(!locked.ok && locked.status === 429, 'too many wrong tokens lock logging in, even for the right one');
    clock += 61 * 1000;
    t.check(limited.login(TOKEN).ok, 'the lock ends after a minute');
    t.equal(cookieValue('a=1; sbxweb=abc; b=2'), 'abc', 'the cookie is found among others');

    t.section('Host, Origin and CSRF checks');
    t.check(
      hostAllowed('127.0.0.1:47800', 47800) && hostAllowed('localhost:47800', 47800),
      'loopback names are allowed',
    );
    t.check(
      !hostAllowed('evil.example:47800', 47800) &&
        !hostAllowed('127.0.0.1:1', 47800) &&
        !hostAllowed(undefined, 47800) &&
        !hostAllowed('127.0.0.1.evil.example:47800', 47800),
      'any other Host is refused (DNS rebinding)',
    );
    t.check(
      originAllowed('http://127.0.0.1:47800', '127.0.0.1:47800', 47800) &&
        !originAllowed('http://evil.example', '127.0.0.1:47800', 47800) &&
        !originAllowed(undefined, '127.0.0.1:47800', 47800) &&
        !originAllowed('http://localhost:47800', '127.0.0.1:47800', 47800),
      'the Origin must be the page itself',
    );
    t.check(csrfOk({ [CSRF_HEADER]: CSRF_VALUE }) && !csrfOk({}) && !csrfOk({ [CSRF_HEADER]: '0' }), 'the CSRF header');

    t.section('browser messages');
    t.check(parseClientMessage('{"t":"resize","cols":80,"rows":24}')?.t === 'resize', 'a resize is read');
    t.check(
      [
        'nope',
        '{"t":"resize","cols":0,"rows":24}',
        '{"t":"resize","cols":80.5,"rows":24}',
        '{"t":"resize","cols":80,"rows":99999}',
        '{"t":"input","data":"x"}',
        'null',
      ].every((m) => parseClientMessage(m) === null),
      'garbage, odd numbers and unknown kinds are refused',
    );

    t.section('static files');
    const root = t.dir('web-root');
    t.write(path.join(root, 'index.html'), '<!doctype html><title>x</title>');
    t.write(path.join(root, 'main-ABCD1234.js'), 'console.log(1)');
    t.write(path.join(root, 'notes.exe'), 'MZ');
    t.write(path.join(t.temp, 'secret.txt'), 'TOP SECRET');
    const files = new StaticFiles(root);
    t.check(files.find('/')?.type.startsWith('text/html') === true, '/ is the app');
    t.check(files.find('/main-ABCD1234.js')?.immutable === true, 'a hashed file may be cached for good');
    t.check(files.find('/some/page')?.file === path.join(root, 'index.html'), 'a page of the app is the app');
    t.check(
      [
        '/../secret.txt',
        '/%2e%2e/secret.txt',
        '/a/../../secret.txt',
        '/..%2fsecret.txt',
        '/..\\secret.txt',
        '/x%00.js',
      ].every((p) => files.find(p) === null),
      'paths that leave the folder find nothing',
    );
    t.check(
      files.find('/notes.exe') === null && files.find('/missing.js') === null,
      'unknown types and missing files find nothing',
    );

    t.section('sessions never carry a token');
    const attach = { addresses: ['127.0.0.1'], port: 1234, token: ATTACH_TOKEN };
    const shown = JSON.stringify(webSession(session('s1', attach), 2));
    t.excludes(shown, ATTACH_TOKEN, 'the attach token is not in what the browser gets');
    t.excludes(shown, '1234', 'nor the port');
    t.excludes(shown, '\x1b', 'text from the sandbox is made safe');

    t.section('the server');
    const fake = new FakePtyHost();
    await fake.start();
    const endpoint: Endpoint = { addresses: ['127.0.0.1'], port: fake.port, token: ATTACH_TOKEN };
    const listed: WebSession = webSession(session('abc123'), 0);
    const created: unknown[] = [];
    const backend: WebBackend = {
      info: () =>
        Promise.resolve({
          sandbox: 'running',
          owner: null,
          canUse: true,
          harnesses: ['claude'],
          defaultHarness: 'claude',
          projects: [],
        }),
      sessions: () => Promise.resolve([listed]),
      endpoint: (id) => (id === 'abc123' ? endpoint : null),
      create: (request) => {
        created.push(request);
        return Promise.resolve(listed);
      },
    };
    let stopped = false;
    const server = new WebServer({ port: 0, token: TOKEN, backend, staticRoot: root, onStop: () => (stopped = true) });
    await server.start();
    const { port } = server;
    const origin = 'http://127.0.0.1:' + port;
    const json = { 'Content-Type': 'application/json' };
    const ajax = { ...json, Origin: origin, [CSRF_HEADER]: CSRF_VALUE };
    try {
      const page = await send(port, 'GET', '/');
      t.check(
        page.status === 200 && page.headers['content-type']?.startsWith('text/html') === true,
        'the app is served',
      );
      t.includes(
        String(page.headers['content-security-policy']),
        "script-src 'self'",
        'the page has a CSP without inline scripts',
      );
      t.check(
        !String(page.headers['content-security-policy']).includes("script-src 'self' 'unsafe-inline'") &&
          page.headers['x-content-type-options'] === 'nosniff' &&
          page.headers['x-frame-options'] === 'DENY',
        'and the other protective headers',
      );
      t.equal(
        (await send(port, 'GET', '/', { Host: 'evil.example:' + port })).status,
        421,
        'a foreign Host name is refused',
      );
      t.equal((await send(port, 'GET', '/..%2f..%2fsecret.txt')).status, 404, 'a path out of the folder is a 404');
      t.equal(
        (await send(port, 'GET', '/%2e%2e/secret.txt')).status,
        404,
        'an encoded path out of the folder is a 404',
      );
      t.equal((await send(port, 'POST', '/', {}, 'x')).status, 405, 'the files take only GET');
      t.equal((await send(port, 'GET', '/api/sessions')).status, 401, 'the API needs the login');
      t.equal((await send(port, 'GET', '/api/health')).status, 200, 'health needs none');

      const noCsrf = await send(
        port,
        'POST',
        '/api/login',
        { ...json, Origin: origin },
        JSON.stringify({ token: TOKEN }),
      );
      t.equal(noCsrf.status, 403, 'login without the CSRF header is refused');
      const foreign = await send(
        port,
        'POST',
        '/api/login',
        { ...ajax, Origin: 'http://evil.example' },
        JSON.stringify({ token: TOKEN }),
      );
      t.equal(foreign.status, 403, 'login from another origin is refused');
      const noOrigin = await send(
        port,
        'POST',
        '/api/login',
        { ...json, [CSRF_HEADER]: CSRF_VALUE },
        JSON.stringify({ token: TOKEN }),
      );
      t.equal(noOrigin.status, 403, 'login without an Origin is refused');
      t.equal(
        (await send(port, 'POST', '/api/login', ajax, JSON.stringify({ token: 'wrong' }))).status,
        401,
        'a wrong token',
      );
      t.equal(
        (await send(port, 'POST', '/api/login', { ...ajax, 'Content-Type': 'text/plain' }, '{}')).status,
        415,
        'JSON only',
      );
      const login = await send(port, 'POST', '/api/login', ajax, JSON.stringify({ token: TOKEN }));
      const setCookie = String(login.headers['set-cookie']?.[0] ?? '');
      t.check(
        login.status === 200 && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie),
        'the right token gets a safe cookie',
      );
      const Cookie = setCookie.split(';')[0];

      const list = await send(port, 'GET', '/api/sessions', { Cookie });
      t.check(list.status === 200 && JSON.parse(list.body).length === 1, 'a signed-in browser lists sessions');
      t.excludes(list.body, ATTACH_TOKEN, 'the list has no attach token');
      t.equal((await send(port, 'GET', '/api/info', { Cookie })).status, 200, 'and reads the info');
      t.equal(
        (await send(port, 'POST', '/api/sessions', { ...json, Cookie }, '{}')).status,
        403,
        'a new session needs CSRF and Origin',
      );
      t.equal(
        (await send(port, 'POST', '/api/sessions', { ...ajax, Cookie }, '{"harness":"../x","project":"p"}')).status,
        400,
        'odd names are refused',
      );
      const made = await send(
        port,
        'POST',
        '/api/sessions',
        { ...ajax, Cookie },
        '{"harness":"claude","project":"app"}',
      );
      t.check(made.status === 201 && created.length === 1, 'a new session is requested');

      t.section('the terminal bridge');
      const url = 'ws://127.0.0.1:' + port + '/api/sessions/abc123/terminal?cols=100&rows=40';
      const attempts = [
        new Tab(url, { Cookie }),
        new Tab(url, { Origin: 'http://evil.example', Cookie }),
        new Tab(url, { Origin: origin }),
        new Tab('ws://127.0.0.1:' + port + '/api/sessions/nosuch/terminal', { Origin: origin, Cookie }),
      ];
      await t.waitFor(() => attempts.every((a) => a.failed), 5000);
      t.check(
        attempts.every((a) => !a.opened && a.failed),
        'no Origin, a foreign Origin, no cookie and an unknown session are all refused',
      );
      t.check(fake.hellos.length === 0, 'and the session was never contacted');

      const tab = new Tab(url, { Origin: origin, Cookie });
      await t.waitFor(() => tab.binary.length > 0, 5000);
      t.check(tab.texts.includes('{"t":"ready"}'), 'the browser is told when it is connected');
      const hello = fake.hellos[0];
      t.check(
        hello !== undefined &&
          hello.readInt16LE(0) === 100 &&
          hello.readInt16LE(2) === 40 &&
          hello.subarray(5).toString() === ATTACH_TOKEN,
        'HELLO carries the attach token and the size',
      );
      const output = Buffer.concat(tab.binary).toString();
      t.check(output.includes('hello ') && output.includes('world'), 'output is relayed as binary');
      t.excludes(output, ']52', 'and a clipboard write (OSC 52) in it is dropped');
      tab.socket.send(Buffer.from('abc'));
      tab.socket.send(JSON.stringify({ t: 'resize', cols: 90, rows: 30 }));
      await t.waitFor(() => fake.inputs.length > 0 && fake.resizes.length > 0, 5000);
      t.check(fake.inputs[0]?.toString() === 'abc', 'keystrokes are forwarded as INPUT');
      t.check(
        fake.resizes[0]?.readInt16LE(0) === 90 && fake.resizes[0]?.readInt16LE(2) === 30,
        'a resize is forwarded',
      );
      tab.socket.send(Buffer.from('x'));
      await t.waitFor(() => tab.closeCode !== null, 5000);
      t.check(tab.texts.includes('{"t":"exit","code":3}'), 'EXIT reaches the browser with its code');
      t.equal(tab.closeCode, 1000, 'and the socket closes cleanly');

      const rude = new Tab(url, { Origin: origin, Cookie });
      await t.waitFor(() => rude.binary.length > 0, 5000);
      rude.socket.send('this is not json');
      await t.waitFor(() => rude.closeCode !== null, 5000);
      t.equal(rude.closeCode, 1008, 'a browser that sends garbage is closed');

      const leaving = new Tab(url, { Origin: origin, Cookie });
      await t.waitFor(() => leaving.binary.length > 0, 5000);
      leaving.socket.close();
      await t.waitFor(() => fake.closed >= 3, 5000);
      t.check(fake.closed >= 3, 'closing the browser side closes the connection to the session');

      t.section('stopping');
      t.equal(
        (await send(port, 'POST', '/api/stop', { ...json, Cookie }, '{}')).status,
        403,
        'stop needs CSRF and Origin too',
      );
      t.equal(
        (await send(port, 'POST', '/api/stop', { ...ajax, Cookie }, '{}')).status,
        200,
        'a signed-in browser can stop it',
      );
      await t.waitFor(() => stopped, 3000);
      t.check(stopped, 'the server is told to stop');
    } finally {
      await server.stop();
      fake.stop();
    }

    t.section('the state file');
    const store = new WebStore(t.dir('web-state'), () => undefined);
    store.write({ pid: 1234, port: 47800, token: TOKEN, startedAt: '2026-01-01T00:00:00.000Z' });
    t.equal(store.read()?.port, 47800, 'pid, port and token are kept');
    t.write(path.join(store.dir, 'server.json'), '{"pid":1,"port":1,"token":"short","startedAt":"x"}');
    t.check(store.read() === null, 'a state file that does not fit the schema is ignored');
    store.clear();
    t.check(store.read() === null, 'and it can be removed');
  },
};
