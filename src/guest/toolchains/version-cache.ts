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
const resolvedFile = (): string => tool('resolved-versions.json');
const remembered = (): Record<string, { value: string; at: number }> =>
  Object.fromEntries(
    Object.entries(readState(resolvedFile(), ResolvedSchema, {})).map(([k, v]) => [
      k,
      typeof v === 'string' ? { value: v, at: 0 } : v,
    ]),
  );

/** How long a looked-up version is trusted: boots within a day make no version lookups at all. */
const FRESH_MS = 24 * 60 * 60 * 1000;
let offline = false;
const networkError = (e: unknown): boolean =>
  /fetch failed|timed? ?out|aborted|ENOTFOUND|EAI_AGAIN|ECONN|ENETUNREACH|EHOSTUNREACH|HTTP 5\d\d|socket/i.test(
    errMsg(e) + ' ' + String((e as { cause?: unknown })?.cause ?? ''),
  );

/**
 * Resolves a version online and remembers it for a day (provisioning.refresh looks again), so most boots make no
 * lookups and an offline boot reuses what was installed last time. After a network failure the remaining lookups go
 * straight to the remembered versions instead of each waiting for the network; other errors (no such version) do not.
 */
export const resolveCached = async (key: string, resolve: () => Promise<string>): Promise<string> => {
  const cached = remembered()[key];
  if (cached && (offline || (!session.provisioning.refresh && Date.now() - cached.at < FRESH_MS))) return cached.value;
  try {
    const value = await resolve();
    fs.mkdirSync(toolsDir, { recursive: true });
    writeJsonAtomic(resolvedFile(), { ...remembered(), [key]: { value, at: Date.now() } });
    return value;
  } catch (e) {
    if (networkError(e)) offline = true;
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
};
