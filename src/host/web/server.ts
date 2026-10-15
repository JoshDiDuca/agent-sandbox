// The web UI's HTTP server: the app's files, a small JSON API for sessions, the terminal WebSocket and the RPC
// WebSocket of the shared core. Loopback only; nothing works without the token's cookie, and Host / Origin / CSRF
// checks keep other sites out (docs/web-ui.md).
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { RpcHost } from '../../app/kernel/index.js';
import { UserError, safeText } from '../../core/util/index.js';
import type { Endpoint } from '../../shared/pty/index.js';
import {
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  type NewSessionRequest,
} from '../../shared/web/index.js';
import { cookieHeader, csrfOk, hostAllowed, originAllowed, WebAuth } from './auth.js';
import type { WebBackend } from './backend.js';
import { TerminalBridge } from './bridge.js';
import { RpcSession } from './rpc.js';
import { StaticFiles } from './static-files.js';

/** No inline script: the page and its script are files from this server. Inline styles are what xterm.js needs. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TERMINALS = 16;
const MAX_RPC_SOCKETS = 8;
const SESSION_PATH = /^\/api\/sessions\/([A-Za-z0-9_-]{1,64})\/terminal$/;
export const RPC_PATH = '/api/rpc';

export interface WebServerOptions {
  /** 0 picks a free port (tests). */
  readonly port: number;
  readonly token: string;
  readonly backend: WebBackend;
  /** The folder of the built app (dist/web). */
  readonly staticRoot: string;
  /** Called when a signed-in browser (or the CLI) asks the server to stop. */
  readonly onStop?: () => void;
  /** How terminals reach a session (tests use a fake on loopback). */
  readonly dial?: (endpoint: Endpoint) => Promise<net.Socket>;
  /** The shared core's operations and queries the browser may run (none: /api/rpc is not served). */
  readonly rpc?: RpcHost;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class WebServer {
  private readonly server: http.Server;
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  private readonly auth: WebAuth;
  private readonly files: StaticFiles;
  private terminals = 0;
  private rpcSockets = 0;
  private actualPort = 0;

  constructor(private readonly options: WebServerOptions) {
    this.auth = new WebAuth(options.token);
    this.files = new StaticFiles(options.staticRoot);
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.headersTimeout = 15000;
    this.server.requestTimeout = 0; // creating a session waits for the agent to start
  }

  get port(): number {
    return this.actualPort;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, '127.0.0.1', () => {
        this.server.off('error', reject);
        this.actualPort = (this.server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    for (const client of this.sockets.clients) client.close(1001, 'server stopping');
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private headers(extra: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
    return {
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...extra,
    };
  }

  private json(res: http.ServerResponse, status: number, body: unknown, extra: http.OutgoingHttpHeaders = {}): void {
    res.writeHead(
      status,
      this.headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }),
    );
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (!hostAllowed(req.headers.host, this.actualPort)) throw new HttpFailure(421, 'Wrong host name.');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) await this.api(req, res, url.pathname);
      else this.serveFile(req, res, url.pathname);
    } catch (e) {
      if (e instanceof HttpFailure) this.json(res, e.status, { error: e.message });
      else if (e instanceof UserError) this.json(res, 409, { error: safeText(e.message).slice(0, 500) });
      else this.json(res, 500, { error: 'Something went wrong.' });
    }
  }

  private serveFile(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpFailure(405, 'Not allowed.');
    const file = this.files.find(pathname);
    if (!file) throw new HttpFailure(404, 'Not found.');
    const size = fs.statSync(file.file).size;
    res.writeHead(
      200,
      this.headers({
        'Content-Type': file.type,
        'Content-Length': size,
        'Cache-Control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      }),
    );
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file.file).pipe(res);
  }

  /** A call that changes something: the custom header, and an Origin that is this page. */
  private requireSameSite(req: http.IncomingMessage): void {
    if (!csrfOk(req.headers) || !originAllowed(req.headers.origin, req.headers.host, this.actualPort))
      throw new HttpFailure(403, 'Refused.');
  }

  private async api(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    const method = req.method ?? 'GET';
    const { backend } = this.options;
    if (pathname === '/api/health' && method === 'GET') return this.json(res, 200, { ok: true });
    if (pathname === '/api/login' && method === 'POST') {
      this.requireSameSite(req);
      const body = await this.body(req);
      const result = this.auth.login((body as { token?: unknown } | null)?.token);
      if (!result.ok) throw new HttpFailure(result.status, result.status === 429 ? 'Too many tries.' : 'Wrong token.');
      return this.json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(result.cookie) });
    }
    if (!this.auth.signedIn(req.headers.cookie)) throw new HttpFailure(401, 'Not signed in.');
    if (pathname === '/api/info' && method === 'GET') return this.json(res, 200, await backend.info());
    if (pathname === '/api/sessions' && method === 'GET') return this.json(res, 200, await backend.sessions());
    if (pathname === '/api/sessions' && method === 'POST') {
      this.requireSameSite(req);
      const request = newSessionRequest(await this.body(req));
      if (!request) throw new HttpFailure(400, 'Choose an agent and a project.');
      return this.json(res, 201, await backend.create(request));
    }
    if (pathname === '/api/stop' && method === 'POST') {
      this.requireSameSite(req);
      this.json(res, 200, { ok: true });
      setTimeout(() => this.options.onStop?.(), 100);
      return;
    }
    throw new HttpFailure(404, 'Not found.');
  }

  /** A small JSON body (application/json only). */
  private body(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? ''))
        return reject(new HttpFailure(415, 'Send JSON.'));
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          reject(new HttpFailure(413, 'Too big.'));
        } else chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpFailure(400, 'Not JSON.'));
        }
      });
      req.on('error', reject);
    });
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: string): void => {
      socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\n\r\n');
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = SESSION_PATH.exec(url.pathname);
    const rpc = url.pathname === RPC_PATH ? this.options.rpc : undefined;
    if (!match && !rpc) return refuse('404 Not Found');
    // The Origin must be this page (a page of another site can open WebSockets too) and the cookie is the login.
    if (!originAllowed(req.headers.origin, req.headers.host, this.actualPort)) return refuse('403 Forbidden');
    if (!this.auth.signedIn(req.headers.cookie)) return refuse('401 Unauthorized');
    if (rpc) return this.upgradeRpc(req, socket, head, rpc, refuse);
    if (!match) return refuse('404 Not Found');
    if (this.terminals >= MAX_TERMINALS) return refuse('503 Service Unavailable');
    const endpoint = this.options.backend.endpoint(match[1]);
    if (!endpoint) return refuse('404 Not Found');
    const cols = bounded(url.searchParams.get('cols'), MIN_COLS, MAX_COLS, 120);
    const rows = bounded(url.searchParams.get('rows'), MIN_ROWS, MAX_ROWS, 30);
    this.sockets.handleUpgrade(req, socket, head, (ws) => {
      this.terminals++;
      ws.on('close', () => this.terminals--);
      void new TerminalBridge(ws, endpoint, cols, rows, this.options.dial).start();
    });
  }

  /** The RPC socket (after the same Origin and cookie checks as a terminal). */
  private upgradeRpc(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    rpc: RpcHost,
    refuse: (status: string) => void,
  ): void {
    if (this.rpcSockets >= MAX_RPC_SOCKETS) return refuse('503 Service Unavailable');
    this.sockets.handleUpgrade(req, socket, head, (ws) => {
      this.rpcSockets++;
      ws.on('close', () => this.rpcSockets--);
      new RpcSession(ws, rpc).start();
    });
  }
}

function bounded(text: string | null, min: number, max: number, fallback: number): number {
  const n = Number(text);
  return text !== null && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function newSessionRequest(body: unknown): NewSessionRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const { harness, project } = body as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v);
  return ok(harness) && ok(project) ? { harness, project } : null;
}
