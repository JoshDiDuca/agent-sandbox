// The run folder (<data>\run on the host, C:\AgentData\run in the sandbox) is the host <-> sandbox channel. No
// network needed: boot status, requests (host -> guest) and responses/status (guest -> host) are small JSON files,
// written atomically and parsed with the channel schemas on read. Anything that does not parse is ignored.
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { GuestRequest, GuestResponse, Id, ProjectStatus, SandboxStatus, SessionStatus } from './schema.js';
import type { GuestRequestT, GuestResponseT, ProjectStatusT, SandboxStatusT, SessionStatusT } from './schema.js';
import { readValid } from '../io/index.js';

/** Ids become file names, so only a strict alphabet is allowed (no separators, no dots). */
export const safeId = (id: string): string => Id.parse(id);

export const runPaths = (dataDir: string) => {
  const run = path.join(dataDir, 'run');
  const file =
    (dir: string) =>
    (id: string): string =>
      path.join(run, dir, safeId(id) + '.json');
  return {
    run,
    sandbox: path.join(run, 'sandbox.json'),
    requests: path.join(run, 'requests'),
    responses: path.join(run, 'responses'),
    sessions: path.join(run, 'sessions'),
    projects: path.join(run, 'projects'),
    /** audit.processes: programs the sandbox started, in small .jsonl files the host takes in and deletes. */
    audit: path.join(run, 'audit'),
    request: file('requests'),
    response: file('responses'),
    session: file('sessions'),
    project: file('projects'),
  };
};

/** Message files in a folder (strict names only), validated; invalid ones are reported separately for deletion. */
const scan = <S extends z.ZodType>(schema: S, dir: string): { valid: z.output<S>[]; invalid: string[] } => {
  if (!fs.existsSync(dir)) return { valid: [], invalid: [] };
  const valid: z.output<S>[] = [];
  const invalid: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.tmp')) continue;
    const message = /^[A-Za-z0-9_-]{1,64}\.json$/.test(name) ? readValid(schema, path.join(dir, name)) : null;
    if (message) valid.push(message);
    else invalid.push(path.join(dir, name));
  }
  return { valid, invalid };
};

export const readSandboxStatus = (dataDir: string): SandboxStatusT | null =>
  readValid(SandboxStatus, runPaths(dataDir).sandbox);
export const readSession = (dataDir: string, id: string): SessionStatusT | null =>
  readValid(SessionStatus, runPaths(dataDir).session(id));
export const readResponse = (dataDir: string, id: string): GuestResponseT | null =>
  readValid(GuestResponse, runPaths(dataDir).response(id));
export const listSessions = (dataDir: string): SessionStatusT[] =>
  scan(SessionStatus, runPaths(dataDir).sessions).valid.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
export const readProjectStatus = (dataDir: string, name: string): ProjectStatusT | null =>
  readValid(ProjectStatus, runPaths(dataDir).project(name));
export const listProjectStatus = (dataDir: string): ProjectStatusT[] =>
  scan(ProjectStatus, runPaths(dataDir).projects).valid.slice(0, 64);
export const scanRequests = (dataDir: string): { valid: GuestRequestT[]; invalid: string[] } =>
  scan(GuestRequest, runPaths(dataDir).requests);
export const now = (): string => new Date().toISOString();
