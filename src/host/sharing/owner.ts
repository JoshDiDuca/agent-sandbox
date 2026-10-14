// Who started the running Windows Sandbox, from the process list (tasklist shows every session's processes to standard
// users) and the records the starters wrote. Pure: the caller runs tasklist and reads the records.
import type { ActiveSandbox } from './active-record.js';

export interface TaskRow {
  image: string;
  pid: number;
  session: number;
}

export type SandboxOwner =
  | { kind: 'none' }
  | { kind: 'mine' }
  | { kind: 'other'; user: string; shared: boolean; record: ActiveSandbox }
  | { kind: 'unknown-other' };

/** The sandbox's window processes, most specific first: the first one that is running decides. */
const SANDBOX_IMAGES = ['WindowsSandboxClient.exe', 'WindowsSandboxRemoteSession.exe', 'WindowsSandbox.exe'];

/** One CSV line: quoted fields, "" inside quotes, commas inside quotes kept ("1,234 K"). */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (c === '"') quoted = false;
      else current += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      fields.push(current);
      current = '';
    } else current += c;
  }
  fields.push(current);
  return fields;
}

/**
 * `tasklist /NH /FO CSV` output: "Image","PID","Session Name","Session#","Mem Usage". Lines that are not process rows
 * (such as "INFO: No tasks are running ...") are skipped.
 */
export function parseTasklist(csv: string): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const fields = csvFields(line);
    if (fields.length < 4) continue;
    const pid = Number(fields[1]);
    const session = Number(fields[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(session) || session < 0) continue;
    rows.push({ image: fields[0], pid, session });
  }
  return rows;
}

/**
 * Whether the sandbox is this user's, another user's (and whether they share it), or of someone whose record this PC
 * does not have. A record whose session has no running sandbox is stale and ignored.
 */
export function whoOwnsSandbox(rows: TaskRow[], mySession: number, records: ActiveSandbox[]): SandboxOwner {
  let sessions: number[] = [];
  for (const image of SANDBOX_IMAGES) {
    const found = rows.filter((r) => r.image.toLowerCase() === image.toLowerCase());
    if (found.length) {
      sessions = [...new Set(found.map((r) => r.session))];
      break;
    }
  }
  if (sessions.length === 0) return { kind: 'none' };
  if (sessions.includes(mySession)) return { kind: 'mine' };
  const record = records.find((r) => sessions.includes(r.windowsSession));
  if (!record) return { kind: 'unknown-other' };
  return { kind: 'other', user: record.user, shared: record.shared, record };
}
