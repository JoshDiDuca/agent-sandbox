// What goes into the audit log, from the background watcher while the sandbox runs:
//  - programs started in the sandbox: the .jsonl files it leaves in run\audit\ (untrusted: links refused, each file
//    and line size-capped, every line checked and forced to kind "proc"), taken in and deleted;
//  - files changed in the projects: watched from this PC (the sandbox cannot hide or fake these);
//  - sessions starting and ending, and what the repo guard caught.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertNoLinks } from '../../core/util/index.js';
import { listSessions, runPaths } from '../../shared/channel/index.js';
import { JsonFile } from '../../shared/io/index.js';
import { AuditEvent, AuditLog, fold } from './log.js';

const MAX_FILES_PER_PASS = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Paths in a project not worth a line each (git's own bookkeeping, dependency folders). */
const QUIET =
  /(^|[\\/])(\.git[\\/](objects|logs|refs|index\.lock|FETCH_HEAD|ORIG_HEAD)|node_modules[\\/]|target[\\/]|\.venv[\\/]|__pycache__[\\/])/i;

const AuditSettings = z.object({
  enabled: z.boolean(),
  days: z.number().int().min(1).max(365),
  maxMb: z.number().int().min(5).max(5000),
  processes: z.boolean(),
  files: z.boolean(),
  projects: z.array(z.string().max(1024)).max(64),
});
export type AuditSettings = z.output<typeof AuditSettings>;
const settingsFile = (storageRoot: string, dataPath: string): JsonFile<AuditSettings> =>
  new JsonFile(AuditSettings, path.join(storageRoot, 'sync', path.basename(dataPath) + '-audit.json'));

/** Host-only: the audit settings of the running sandbox (written at launch, read by the watcher). */
export const saveAuditSettings = (storageRoot: string, dataPath: string, settings: AuditSettings): void =>
  settingsFile(storageRoot, dataPath).write(settings);
export const readAuditSettings = (storageRoot: string, dataPath: string): AuditSettings | null =>
  settingsFile(storageRoot, dataPath).read();

export class AuditCollector {
  private readonly log: AuditLog;
  private pending: AuditEvent[] = [];
  private sessions = new Map<string, string>();
  private watchers: fs.FSWatcher[] = [];

  constructor(
    private readonly dataPath: string,
    storageRoot: string,
    private readonly settings: AuditSettings,
  ) {
    this.log = new AuditLog(AuditLog.dirFor(storageRoot, dataPath), settings);
  }

  private add(e: Omit<AuditEvent, 't'> & { t?: string }): void {
    this.pending.push({ t: new Date().toISOString(), ...e });
  }

  /** Starts watching the projects' files (when audit.files). */
  start(): void {
    this.add({
      k: 'note',
      p:
        'sandbox started; audit: ' +
        [this.settings.processes && 'programs', this.settings.files && 'files', 'sessions'].filter(Boolean).join(', '),
    });
    if (!this.settings.files) return;
    for (const project of this.settings.projects) {
      try {
        this.watchers.push(
          fs.watch(project, { recursive: true }, (event, file) => {
            const rel = file ? String(file) : '';
            if (!rel || QUIET.test(rel)) return;
            this.add({
              k: 'file',
              a: event === 'rename' ? 'rename' : 'change',
              p: rel.replace(/\\/g, '/').slice(0, 1024),
              w: project,
            });
          }),
        );
      } catch {
        /* a project that is gone */
      }
    }
  }

  /** Programs the sandbox reported: taken in (checked) and deleted. */
  private takeGuestReports(): void {
    if (!this.settings.processes) return;
    const dir = runPaths(this.dataPath).audit;
    assertNoLinks(this.dataPath, dir);
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(dir)
        .filter((n) => /^[\w-]+\.jsonl$/.test(n))
        .sort()
        .slice(0, MAX_FILES_PER_PASS);
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
          for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim() || line.length > 8192) continue;
            let raw: unknown;
            try {
              raw = JSON.parse(line);
            } catch {
              continue;
            }
            const e = AuditEvent.safeParse(raw);
            if (e.success) this.pending.push({ ...e.data, k: 'proc', w: undefined, a: undefined });
          }
        }
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
  }

  private trackSessions(): void {
    const now = new Map(listSessions(this.dataPath).map((s) => [s.id, s.phase]));
    for (const s of listSessions(this.dataPath)) {
      const before = this.sessions.get(s.id);
      if (!before && s.phase === 'running') this.add({ k: 'session', a: 'start', p: s.harness, w: s.cwd, c: s.id });
      if (before === 'running' && (s.phase === 'exited' || s.phase === 'failed'))
        this.add({
          k: 'session',
          a: 'end',
          p: s.harness,
          w: s.cwd,
          c: s.id + (s.exitCode !== undefined ? ' exit ' + s.exitCode : ''),
        });
    }
    this.sessions = now;
  }

  guard(detail: string): void {
    this.add({ k: 'guard', p: detail.slice(0, 1024) });
  }

  /** Writes what came in since the last call (repeats folded); call every few seconds. */
  flush(): void {
    try {
      this.takeGuestReports();
    } catch {
      /* next pass */
    }
    try {
      this.trackSessions();
    } catch {
      /* next pass */
    }
    const events = this.pending.sort((a, b) => a.t.localeCompare(b.t));
    this.pending = [];
    this.log.append(fold(events));
  }

  stop(): void {
    this.watchers.forEach((w) => w.close());
    this.add({ k: 'note', p: 'sandbox closed' });
    this.flush();
    this.log.maintain();
  }

  maintain(): void {
    this.log.maintain();
  }
}
