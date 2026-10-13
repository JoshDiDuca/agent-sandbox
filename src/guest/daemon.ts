// Session daemon (runs detached inside the sandbox for its whole life). It is the only thing that acts on host
// requests, and it only knows four request kinds: start a session, run a command, restart sessions, ping.
// It must never die quietly: every iteration is guarded, and anything unexpected is written to its log.
// The handlers live in daemon/ (session, exec); this file is the polling loop.
import fs from 'node:fs';
import type { GuestRequest } from '../core/types.js';
import { readSession, scanRequests } from '../shared/rundir.js';
import { saveClaudeMem } from './setup/claude.js';
import { execCommand } from './daemon/exec.js';
import { startRelays } from './daemon/relays.js';
import { startProcessCollector } from './audit.js';
import { prepareProject, restartSessions, startSession } from './daemon/session.js';
import { live, respond, safely } from './daemon/state.js';
import { dataDir, errMsg, log, run, warn } from './env.js';

let lastMemSave = Date.now();

process.on('uncaughtException', (e) => warn('daemon: unexpected error (continuing): ' + (e.stack ?? errMsg(e))));
process.on('unhandledRejection', (e) => warn('daemon: unexpected error (continuing): ' + errMsg(e)));

const handle = (req: GuestRequest): Promise<void> | void => {
  switch (req.kind) {
    case 'session': return startSession(req);
    case 'project': return prepareProject(req);
    case 'exec': return execCommand(req);
    case 'restart': return restartSessions(req);
    case 'ping': return respond(req.id, { ok: true, message: 'pong (' + live.size + ' session(s) running)' });
  }
};

const tick = (): void => {
  const { valid, invalid } = scanRequests(dataDir);
  // Anything in requests/ that is not a valid request (wrong kind, bad id, junk) is deleted unread.
  for (const file of invalid) safely('removing an invalid request', () => fs.rmSync(file, { recursive: true, force: true }));
  for (const req of valid) {
    safely('claiming a request', () => fs.rmSync(run.request(req.id), { force: true }));
    if (readSession(dataDir, req.id)) continue;
    // Not awaited: starting a session or running a command must not hold up other requests.
    void Promise.resolve(handle(req)).catch((e: unknown) => respond(req.id, { ok: false, message: errMsg(e) }));
  }
  if (Date.now() - lastMemSave > 120000) { lastMemSave = Date.now(); safely('claude-mem save', saveClaudeMem); }
};

const loop = (): void => {
  try { tick(); } catch (e) { warn('daemon loop: ' + errMsg(e)); } finally { setTimeout(loop, 400); }
};

log('Session daemon started (pid ' + process.pid + ').');
safely('port forwards', startRelays);
safely('audit', startProcessCollector);
loop();
