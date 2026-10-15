// Small helpers the checks share.
import path from 'node:path';
import { assertNoLinks } from '../../../../core/util/index.js';
import type { Finding, RepairEnv } from '../types.js';

export function ok(detail: string): Finding {
  return { status: 'ok', detail };
}

export function rel(root: string, p: string): string {
  return path.relative(root, p) || '.';
}

/** Throws unless every folder from the data folder's parent down to `p` is real (no link the sandbox made). */
export function guard(env: RepairEnv, p: string): void {
  assertNoLinks(path.dirname(env.dataPath), p);
}

export function plural(n: number, one: string, many: string = one + 's'): string {
  return n + ' ' + (n === 1 ? one : many);
}

/** The current Windows user's name (what the group lists, without the domain). */
export function sameUser(account: string, user: string): boolean {
  const a = account.toLowerCase();
  const u = user.toLowerCase();
  return a === u || a.endsWith('\\' + u);
}
