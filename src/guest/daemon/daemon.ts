import fs from 'node:fs';
import type { GuestRequest } from '../../core/types.js';
import { readSession, scanRequests } from '../../shared/channel/run-dir.js';
import { saveClaudeMem } from '../setup/claude-mem.js';
import { execCommand } from './exec.js';
import { prepareProject, restartSessions, startSession } from './sessions.js';
import { live, respond, safely } from './state.js';
import { dataDir, run } from '../runtime/paths.js';
import { warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';

let lastMemSave = Date.now();

const handle = (req: GuestRequest): Promise<void> | void => {
  switch (req.kind) {
    case 'session':
      return startSession(req);
    case 'project':
      return prepareProject(req);
    case 'exec':
      return execCommand(req);
    case 'restart':
      return restartSessions(req);
    case 'ping':
      return respond(req.id, { ok: true, message: 'pong (' + live.size + ' session(s) running)' });
  }
};

const tick = (): void => {
  const { valid, invalid } = scanRequests(dataDir);
  // Anything in requests/ that is not a valid request (wrong kind, bad id, junk) is deleted unread.
  for (const file of invalid)
    safely('removing an invalid request', () => fs.rmSync(file, { recursive: true, force: true }));
  for (const req of valid) {
    safely('claiming a request', () => fs.rmSync(run.request(req.id), { force: true }));
    if (readSession(dataDir, req.id)) continue;
    // Not awaited: starting a session or running a command must not hold up other requests.
    void Promise.resolve(handle(req)).catch((e: unknown) => respond(req.id, { ok: false, message: errMsg(e) }));
  }
  if (Date.now() - lastMemSave > 120000) {
    lastMemSave = Date.now();
    safely('claude-mem save', saveClaudeMem);
  }
};

export const loop = (): void => {
  try {
    tick();
  } catch (e) {
    warn('daemon loop: ' + errMsg(e));
  } finally {
    setTimeout(loop, 400);
  }
};
