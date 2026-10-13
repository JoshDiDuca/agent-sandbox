// Versions looked up online, remembered in tools\resolved-versions.json so most boots make no lookups and an offline
// boot reuses what was installed last time.
import fs from 'node:fs';
import { z } from 'zod';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { warn } from '../runtime/log.js';
import { session } from '../runtime/session.js';
import { toolsDir } from '../runtime/paths.js';
import { errMsg } from '../../core/util/errors.js';
import { tool } from './tool-env.js';
import { readState } from './state-file.js';

/** A remembered lookup; plain strings are what older versions wrote (treated as stale, still usable offline). */
const ResolvedSchema = z.record(
  z.string(),
  z.union([z.string(), z.strictObject({ value: z.string(), at: z.number() })]),
);

interface Remembered {
  readonly value: string;
  readonly at: number;
}

/** How long a looked-up version is trusted: boots within a day make no version lookups at all. */
const FRESH_MS = 24 * 60 * 60 * 1000;

function isNetworkError(e: unknown): boolean {
  return /fetch failed|timed? ?out|aborted|ENOTFOUND|EAI_AGAIN|ECONN|ENETUNREACH|EHOSTUNREACH|HTTP 5\d\d|socket/i.test(
    errMsg(e) + ' ' + String((e as { cause?: unknown })?.cause ?? ''),
  );
}

export class VersionCache {
  /** Set after a network failure: the remaining lookups go straight to the remembered versions. */
  private offline = false;

  constructor(private readonly file: () => string = () => tool('resolved-versions.json')) {}

  /**
   * Resolves a version online and remembers it for a day (provisioning.refresh looks again). After a network failure
   * the remaining lookups use the remembered versions instead of each waiting for the network; other errors (no such
   * version) do not.
   */
  async resolve(key: string, resolve: () => Promise<string>): Promise<string> {
    const cached = this.remembered()[key];
    if (cached && (this.offline || (!session.provisioning.refresh && Date.now() - cached.at < FRESH_MS)))
      return cached.value;
    try {
      const value = await resolve();
      fs.mkdirSync(toolsDir, { recursive: true });
      writeJsonAtomic(this.file(), { ...this.remembered(), [key]: { value, at: Date.now() } });
      return value;
    } catch (e) {
      if (isNetworkError(e)) this.offline = true;
      if (!cached) throw e;
      warn(
        'Could not look up the latest ' +
          key +
          ' online (' +
          errMsg(e) +
          '); using ' +
          cached.value +
          ' from an earlier start.',
      );
      return cached.value;
    }
  }

  private remembered(): Record<string, Remembered> {
    return Object.fromEntries(
      Object.entries(readState(this.file(), ResolvedSchema, {})).map(([k, v]) => [
        k,
        typeof v === 'string' ? { value: v, at: 0 } : v,
      ]),
    );
  }
}

export const versionCache = new VersionCache();

/** versionCache.resolve: the version for `key`, looked up at most once a day. */
export function resolveCached(key: string, resolve: () => Promise<string>): Promise<string> {
  return versionCache.resolve(key, resolve);
}
