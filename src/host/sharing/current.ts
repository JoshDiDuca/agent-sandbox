// Facts about this PC and this user that sharing needs, read from Windows' own tools (never from the sandbox).
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { insideSandbox } from '../sandbox/platform.js';
import { activeDir } from './machine-paths.js';
import { ActiveRecords } from './active-record.js';
import { parseTasklist, whoOwnsSandbox, type SandboxOwner, type TaskRow } from './owner.js';

const HELPER_TIMEOUT_MS = 15000;

/** The rows of `tasklist /NH /FO CSV`: every process of every session (standard users may see these). */
export function listProcesses(): TaskRow[] {
  const run = spawnSync(SYSTEM.tasklist(), ['/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: HELPER_TIMEOUT_MS,
  });
  return parseTasklist(run.stdout ?? '');
}

/** The Windows session this process runs in (0 = services, 1 = the first signed-in user ...), or null when unknown. */
export function sessionOf(rows: readonly TaskRow[], pid: number = process.pid): number | null {
  return rows.find((row) => row.pid === pid)?.session ?? null;
}

/** This user's SID, from `whoami /user`: `"DOMAIN\name","S-1-5-21-..."`. */
export function currentUserSid(): string {
  const run = spawnSync(SYSTEM.whoami(), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: HELPER_TIMEOUT_MS,
  });
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec((run.stdout ?? '').trim())?.[1];
  if (!sid) throw new Error('Could not find out who you are (whoami /user gave: ' + (run.stdout || run.stderr) + ').');
  return sid;
}

export function currentUserName(): string {
  return os.userInfo().username;
}

/** Who started the running sandbox: nobody, this user, another user, or someone whose record is not there. */
export function runningOwner(records: ActiveRecords = new ActiveRecords(activeDir())): SandboxOwner {
  if (insideSandbox()) return { kind: 'mine' };
  const rows = listProcesses();
  const mine = sessionOf(rows);
  // Without our own session we cannot tell whose the window is: whatever runs is somebody else's.
  return whoOwnsSandbox(rows, mine ?? -1, records.readAll());
}
