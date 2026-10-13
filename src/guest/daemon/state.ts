// What the daemon's request handlers share: the running sessions and best-effort status/response writes.
import path from 'node:path';
import type { GuestResponse, SessionStatus } from '../../core/types.js';
import { now } from '../../shared/channel/run-dir.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { insideProjects } from '../../shared/paths/projects.js';
import { run } from '../runtime/paths.js';
import { session, workspace } from '../runtime/session.js';
import { warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';

const MAX_MESSAGE = 3500;

/** Inside the launch folder's workspace. */
export function insidePrimary(cwd: string): boolean {
  const rel = path.relative(workspace.toLowerCase(), path.resolve(cwd).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Inside any project of this sandbox: the launch folder, a project root, or C:\Projects\<name> (older launch folders:
 * only the first).
 */
export function insideWorkspace(cwd: string): boolean {
  return (
    insidePrimary(cwd) ||
    (session.projectsDir !== undefined && insideProjects(path.resolve(cwd), session.roots ?? [], session.projectsDir))
  );
}

/**
 * Status/response writes are best-effort: a briefly locked file (antivirus, the host's sync) must not kill the daemon.
 */
function tryWrite(file: string, value: unknown): void {
  try {
    writeJsonAtomic(file, value);
  } catch (e) {
    warn('Could not write ' + file + ': ' + errMsg(e));
  }
}

export function respond(id: string, result: Omit<GuestResponse, 'id' | 'finishedAt'>): void {
  tryWrite(run.responseFile(id), { id, ...result, message: result.message.slice(0, MAX_MESSAGE), finishedAt: now() });
}

export function saveStatus(status: SessionStatus): void {
  tryWrite(run.sessionFile(status.id), { ...status, message: status.message.slice(0, MAX_MESSAGE), updatedAt: now() });
}

export function safely(what: string, work: () => void): void {
  try {
    work();
  } catch (e) {
    warn(what + ' failed: ' + errMsg(e));
  }
}
