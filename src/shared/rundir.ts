// The run folder (<data>\run on the host, C:\AgentData\run in the sandbox) is the host <-> sandbox channel. No
// network needed: boot status, requests (host -> guest) and responses/status (guest -> host) are small JSON files,
// written atomically and parsed with the channel schemas on read. Anything that does not parse is ignored.
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { GuestRequest, GuestResponse, Id, SandboxStatus, SessionStatus } from './schema.js';
import { assertTestWritable } from './test-guard.js';
import type { GuestRequestT, GuestResponseT, SandboxStatusT, SessionStatusT } from './schema.js';

/** Anything bigger than this from the other side is ignored (a compromised sandbox must not exhaust the host). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Ids become file names, so only a strict alphabet is allowed (no separators, no dots). */
export const safeId = (id: string): string => Id.parse(id);

export const runPaths = (dataDir: string) => {
  const run = path.join(dataDir, 'run');
  const file = (dir: string) => (id: string): string => path.join(run, dir, safeId(id) + '.json');
  return {
    run,
    sandbox: path.join(run, 'sandbox.json'),
    requests: path.join(run, 'requests'),
    responses: path.join(run, 'responses'),
    sessions: path.join(run, 'sessions'),
    request: file('requests'),
    response: file('responses'),
    session: file('sessions'),
  };
};

export const readJsonFile = <T>(file: string): T | null => {
  try {
    if (fs.statSync(file).size > MAX_MESSAGE_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T;
  } catch { return null; }
};

/** Reads and validates; a missing, oversized or malformed file is simply absent. */
export const readValid = <S extends z.ZodType>(schema: S, file: string): z.output<S> | null => {
  const parsed = schema.safeParse(readJsonFile<unknown>(file));
  return parsed.success ? parsed.data : null;
};

const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Write to a uniquely named temp file and rename, so a reader on the other side of the mapped folder never sees half a
 * file. The rename is retried briefly: antivirus or the other side's reader can hold the target for a moment.
 */
export const writeJsonAtomic = (file: string, value: unknown): void => writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');

/** Same for any text file (two commands at once, or a watcher and a command, never leave a half-written file). */
export const writeFileAtomic = (file: string, text: string): void => {
  assertTestWritable(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '-' + Math.random().toString(36).slice(2) + '.tmp';
  fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
  for (let attempt = 1; ; attempt++) {
    try { fs.renameSync(temp, file); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) { fs.rmSync(temp, { force: true }); throw e; }
      pause(50 * attempt);
    }
  }
};

/** Message files in a folder (strict names only), validated; invalid ones are reported separately for deletion. */
const scan = <S extends z.ZodType>(schema: S, dir: string): { valid: z.output<S>[]; invalid: string[] } => {
  if (!fs.existsSync(dir)) return { valid: [], invalid: [] };
  const valid: z.output<S>[] = [];
  const invalid: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.tmp')) continue;
    const message = /^[A-Za-z0-9_-]{1,64}\.json$/.test(name) ? readValid(schema, path.join(dir, name)) : null;
    if (message) valid.push(message); else invalid.push(path.join(dir, name));
  }
  return { valid, invalid };
};

export const readSandboxStatus = (dataDir: string): SandboxStatusT | null => readValid(SandboxStatus, runPaths(dataDir).sandbox);
export const readSession = (dataDir: string, id: string): SessionStatusT | null => readValid(SessionStatus, runPaths(dataDir).session(id));
export const readResponse = (dataDir: string, id: string): GuestResponseT | null => readValid(GuestResponse, runPaths(dataDir).response(id));
export const listSessions = (dataDir: string): SessionStatusT[] => scan(SessionStatus, runPaths(dataDir).sessions).valid.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
export const scanRequests = (dataDir: string): { valid: GuestRequestT[]; invalid: string[] } => scan(GuestRequest, runPaths(dataDir).requests);
export const now = (): string => new Date().toISOString();
