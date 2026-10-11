// The run folder (<data>\run on the host, C:\AgentData\run in the sandbox) is the host <-> sandbox channel. No
// network needed: boot status, requests (host -> guest) and responses/status (guest -> host) are small JSON files
// written atomically. The guest only ever acts on the request kinds in GuestRequest; the host only ever reads data.
import fs from 'node:fs';
import path from 'node:path';
import type { GuestRequest, GuestResponse, SandboxStatus, SessionStatus } from '../core/types.js';

/** Anything bigger than this from the other side is ignored (a compromised sandbox must not exhaust the host). */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

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

/** Ids become file names, so only allow a strict alphabet (no separators, no dots). */
export const safeId = (id: string): string => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid id: ' + JSON.stringify(id).slice(0, 80));
  return id;
};

export const readJsonFile = <T>(file: string): T | null => {
  try {
    if (fs.statSync(file).size > MAX_MESSAGE_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T;
  } catch { return null; }
};

/** Write to a temp file and rename, so a reader on the other side of the mapped folder never sees half a file. */
export const writeJsonAtomic = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
};

const listJson = <T>(dir: string): T[] => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f: string) => /^[A-Za-z0-9_-]{1,64}\.json$/.test(f))
    .map((f: string) => readJsonFile<T>(path.join(dir, f)))
    .filter((x: T | null): x is T => x !== null);
};

const isString = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max;

/** Host-side validation of guest-written session status: wrong shapes are dropped, never trusted. */
export const validSession = (s: unknown): s is SessionStatus => {
  const v = s as SessionStatus;
  return typeof s === 'object' && s !== null && isString(v.id, 64) && /^[A-Za-z0-9_-]+$/.test(v.id) && isString(v.harness, 64) && isString(v.cwd) && isString(v.message)
    && ['starting', 'running', 'exited', 'failed'].includes(v.phase) && isString(v.startedAt, 64)
    && (v.attach === undefined || (Array.isArray(v.attach.addresses) && v.attach.addresses.length <= 16 && v.attach.addresses.every((a) => isString(a, 64)) && Number.isInteger(v.attach.port) && v.attach.port > 0 && v.attach.port < 65536 && isString(v.attach.token, 256)));
};

export const validResponse = (r: unknown): r is GuestResponse => {
  const v = r as GuestResponse;
  return typeof r === 'object' && r !== null && isString(v.id, 64) && typeof v.ok === 'boolean' && isString(v.message, 65536)
    && (v.stdout === undefined || isString(v.stdout, MAX_MESSAGE_BYTES)) && (v.stderr === undefined || isString(v.stderr, MAX_MESSAGE_BYTES));
};

export const validRequest = (r: unknown): r is GuestRequest => {
  const v = r as GuestRequest;
  if (typeof r !== 'object' || r === null || !isString(v.id, 64) || !/^[A-Za-z0-9_-]+$/.test(v.id)) return false;
  switch (v.kind) {
    case 'session': return isString(v.harness, 64) && Array.isArray(v.args) && v.args.every((a) => isString(a)) && isString(v.cwd);
    case 'exec': return Array.isArray(v.command) && v.command.length > 0 && v.command.every((a) => isString(a)) && isString(v.cwd) && Number.isFinite(v.timeoutSeconds);
    case 'restart': return v.harness === null || isString(v.harness, 64);
    case 'ping': return true;
    default: return false;
  }
};

export const readSandboxStatus = (dataDir: string): SandboxStatus | null => readJsonFile<SandboxStatus>(runPaths(dataDir).sandbox);
export const readSession = (dataDir: string, id: string): SessionStatus | null => { const s = readJsonFile<unknown>(runPaths(dataDir).session(id)); return validSession(s) ? s : null; };
export const listSessions = (dataDir: string): SessionStatus[] => listJson<unknown>(runPaths(dataDir).sessions).filter(validSession).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
export const readResponse = (dataDir: string, id: string): GuestResponse | null => { const r = readJsonFile<unknown>(runPaths(dataDir).response(id)); return validResponse(r) ? r : null; };
export const listRequests = (dataDir: string): GuestRequest[] => listJson<unknown>(runPaths(dataDir).requests).filter(validRequest);
export const now = (): string => new Date().toISOString();
