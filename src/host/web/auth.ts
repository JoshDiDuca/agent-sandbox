// Who may talk to the web UI's server: the token trade, the session cookie, and the checks that stop other sites (and
// other names for this PC) from driving it. Pure apart from the clock and the random source (self-test covers it).
import crypto from 'node:crypto';
import { COOKIE_NAME, CSRF_HEADER, CSRF_VALUE } from '../../shared/web/index.js';

/** A cookie lives this long without being used again. */
export const COOKIE_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** Most signed-in browsers at once. */
export const MAX_COOKIES = 50;
/** This many wrong tokens within the window locks logging in until the window has passed. */
export const MAX_FAILURES = 8;
export const FAILURE_WINDOW_MS = 60 * 1000;

export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Compares two secrets without leaking where they differ (the digests have the same length). */
export function sameSecret(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

/** The Host header must name this PC's loopback and our port: anything else is DNS rebinding or a mistake. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === '127.0.0.1:' + port || host === 'localhost:' + port;
}

/** An Origin header (when there is one) must be our own page. */
export function originAllowed(origin: string | undefined, host: string | undefined, port: number): boolean {
  return host !== undefined && hostAllowed(host, port) && origin === 'http://' + host;
}

/** State-changing calls need the custom header; a form or a no-CORS request from another site cannot send it. */
export function csrfOk(headers: Readonly<Record<string, string | string[] | undefined>>): boolean {
  return headers[CSRF_HEADER] === CSRF_VALUE;
}

export function cookieValue(header: string | undefined, name: string = COOKIE_NAME): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export type LoginResult =
  { readonly ok: true; readonly cookie: string } | { readonly ok: false; readonly status: 401 | 429 };

export class WebAuth {
  private readonly cookies = new Map<string, number>();
  private failures: number[] = [];

  constructor(
    private readonly token: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Trades the token for a new cookie value; wrong tokens are counted, and too many lock this for a minute. */
  login(candidate: unknown): LoginResult {
    const t = this.now();
    this.failures = this.failures.filter((at) => t - at < FAILURE_WINDOW_MS);
    if (this.failures.length >= MAX_FAILURES) return { ok: false, status: 429 };
    if (typeof candidate !== 'string' || candidate.length > 256 || !sameSecret(candidate, this.token)) {
      this.failures.push(t);
      return { ok: false, status: 401 };
    }
    this.expire(t);
    if (this.cookies.size >= MAX_COOKIES) {
      const oldest = [...this.cookies.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.cookies.delete(oldest[0]);
    }
    const cookie = crypto.randomBytes(32).toString('hex');
    this.cookies.set(cookie, t);
    return { ok: true, cookie };
  }

  /** The request's Cookie header carries a signed-in browser's cookie (and renews it). */
  signedIn(cookieHeader: string | undefined): boolean {
    const value = cookieValue(cookieHeader);
    if (!value) return false;
    const t = this.now();
    this.expire(t);
    for (const known of this.cookies.keys()) {
      if (known.length === value.length && sameSecret(known, value)) {
        this.cookies.set(known, t);
        return true;
      }
    }
    return false;
  }

  private expire(t: number): void {
    for (const [cookie, last] of this.cookies) if (t - last > COOKIE_LIFETIME_MS) this.cookies.delete(cookie);
  }
}

/** The Set-Cookie value: not readable by scripts, never sent by another site. */
export function cookieHeader(value: string): string {
  return COOKIE_NAME + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + COOKIE_LIFETIME_MS / 1000;
}
