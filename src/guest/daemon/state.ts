// What the daemon's request handlers share: the running sessions and best-effort status/response writes.
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { GuestResponse, SessionStatus } from '../../core/types.js';
import { now, writeJsonAtomic } from '../../shared/rundir.js';
import { errMsg, run, warn, workspace } from '../env.js';

const MAX_MESSAGE = 3500;

export const live = new Map<string, { status: SessionStatus; child: ChildProcess }>();
/** Sessions being started right now (a headless sandbox must not shut down under them). */
export const pending = { starting: 0 };

export const insideWorkspace = (cwd: string): boolean => {
  const rel = path.relative(workspace.toLowerCase(), path.resolve(cwd).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Status/response writes are best-effort: a briefly locked file (antivirus, the host's sync) must not kill the daemon. */
const tryWrite = (file: string, value: unknown): void => { try { writeJsonAtomic(file, value); } catch (e) { warn('Could not write ' + file + ': ' + errMsg(e)); } };
export const respond = (id: string, result: Omit<GuestResponse, 'id' | 'finishedAt'>): void => tryWrite(run.response(id), { id, ...result, message: result.message.slice(0, MAX_MESSAGE), finishedAt: now() });
export const saveStatus = (status: SessionStatus): void => tryWrite(run.session(status.id), { ...status, message: status.message.slice(0, MAX_MESSAGE), updatedAt: now() });
export const safely = (what: string, work: () => void): void => { try { work(); } catch (e) { warn(what + ' failed: ' + errMsg(e)); } };
