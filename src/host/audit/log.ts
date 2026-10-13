// The audit log (audit.enabled): one file per day of JSON lines in host-only storage (<storage>\audit\<data set>),
// which the sandbox cannot reach. Days before today are gzipped; days past audit.days and, past audit.maxMb, the
// oldest days are deleted. Lines are short (field names are one or two letters) and capped in length.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { z } from 'zod';

/** One event. k: proc (a program started), file (changed in a project), session, guard (repo guard), note. */
export const AuditEvent = z.object({
  /** ISO time. */
  t: z.string().max(40),
  k: z.enum(['proc', 'file', 'session', 'guard', 'note']),
  /** proc: program; file: path in the project; session: agent; guard/note: what happened. */
  p: z.string().max(1024).optional(),
  /** proc: its command line (capped). */
  c: z.string().max(2048).optional(),
  /** proc: the program that started it. */
  pp: z.string().max(1024).optional(),
  /** file: change | rename; session: start | end. */
  a: z.string().max(32).optional(),
  /** project folder (file, session). */
  w: z.string().max(1024).optional(),
  /** how many times it happened in this line's minute (repeats are counted, not repeated). */
  n: z.number().int().min(1).max(1e9).optional(),
});
export type AuditEvent = z.output<typeof AuditEvent>;

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

export class AuditLog {
  constructor(
    readonly dir: string,
    private readonly limits: { days: number; maxMb: number },
  ) {}

  /** <storage>\audit\<data set name>. */
  static dirFor(storageRoot: string, dataPath: string): string {
    return path.join(storageRoot, 'audit', path.basename(dataPath));
  }

  private dayFile(day: string, gz = false): string {
    return path.join(this.dir, day + '.jsonl' + (gz ? '.gz' : ''));
  }

  append(events: AuditEvent[]): void {
    if (!events.length) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const byDay = new Map<string, string[]>();
    for (const e of events) {
      const day = e.t.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(e)]);
    }
    for (const [day, lines] of byDay) fs.appendFileSync(this.dayFile(day), lines.join('\n') + '\n');
  }

  /** Compresses finished days, then deletes days past the limits. Cheap when there is nothing to do. */
  maintain(today = new Date().toISOString().slice(0, 10)): void {
    if (!fs.existsSync(this.dir)) return;
    for (const name of fs.readdirSync(this.dir)) {
      const m = DAY_FILE.exec(name);
      if (!m || m[2] || m[1] >= today) continue;
      const file = path.join(this.dir, name);
      fs.writeFileSync(file + '.gz', zlib.gzipSync(fs.readFileSync(file)));
      fs.rmSync(file);
    }
    const oldest = new Date(Date.parse(today) - (this.limits.days - 1) * 86400000).toISOString().slice(0, 10);
    const files = fs
      .readdirSync(this.dir)
      .filter((n) => DAY_FILE.test(n))
      .sort();
    for (const name of files.filter((n) => DAY_FILE.exec(n)![1] < oldest))
      fs.rmSync(path.join(this.dir, name), { force: true });
    let left = fs
      .readdirSync(this.dir)
      .filter((n) => DAY_FILE.test(n))
      .sort();
    const size = (): number => left.reduce((sum, n) => sum + fs.statSync(path.join(this.dir, n)).size, 0);
    while (left.length > 1 && size() > this.limits.maxMb * 1024 * 1024) {
      fs.rmSync(path.join(this.dir, left[0]), { force: true });
      left = left.slice(1);
    }
  }

  /** Events of the last `days` days (newest last), optionally of some kinds and containing a text. */
  read(o: { days?: number; kinds?: AuditEvent['k'][]; grep?: string } = {}): AuditEvent[] {
    if (!fs.existsSync(this.dir)) return [];
    const since = new Date(Date.now() - ((o.days ?? 1) - 1) * 86400000).toISOString().slice(0, 10);
    const needle = o.grep?.toLowerCase();
    const events: AuditEvent[] = [];
    for (const name of fs
      .readdirSync(this.dir)
      .filter((n) => DAY_FILE.test(n) && DAY_FILE.exec(n)![1] >= since)
      .sort()) {
      const raw = fs.readFileSync(path.join(this.dir, name));
      const text = name.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const e = AuditEvent.safeParse(parsed);
        if (!e.success) continue;
        if (o.kinds?.length && !o.kinds.includes(e.data.k)) continue;
        if (needle && !line.toLowerCase().includes(needle)) continue;
        events.push(e.data);
      }
    }
    return events;
  }

  /** Total size on disk. */
  bytes(): number {
    if (!fs.existsSync(this.dir)) return 0;
    return fs
      .readdirSync(this.dir)
      .filter((n) => DAY_FILE.test(n))
      .reduce((sum, n) => sum + fs.statSync(path.join(this.dir, n)).size, 0);
  }
}

/**
 * Folds repeats: the same event (kind, program/path, command line, action, project) within one minute becomes one line
 * with n = how many times; after `cap` distinct lines a minute, the rest of that minute is one "note" line.
 */
export const fold = (events: AuditEvent[], cap = 300): AuditEvent[] => {
  const out: AuditEvent[] = [];
  const index = new Map<string, AuditEvent>();
  const perMinute = new Map<string, number>();
  const dropped = new Map<string, number>();
  for (const e of events) {
    const minute = e.t.slice(0, 16);
    const key = [minute, e.k, e.p, e.c, e.a, e.w].join('\0');
    const seen = index.get(key);
    if (seen) {
      seen.n = (seen.n ?? 1) + (e.n ?? 1);
      continue;
    }
    const count = (perMinute.get(minute) ?? 0) + 1;
    perMinute.set(minute, count);
    if (count > cap) {
      dropped.set(minute, (dropped.get(minute) ?? 0) + (e.n ?? 1));
      continue;
    }
    const copy = { ...e };
    index.set(key, copy);
    out.push(copy);
  }
  for (const [minute, n] of dropped)
    out.push({ t: minute + ':59.999Z', k: 'note', p: n + ' more events in this minute were not listed (audit cap)' });
  return out;
};
