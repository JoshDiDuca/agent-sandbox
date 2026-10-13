// A project as the sandbox sees it with workspaceFilter on: a copy of the project on this PC (in storage, outside the
// project) that holds only what git does not ignore, kept in step with the project both ways. The sandbox maps the view
// instead of the project, and the project's real .git separately (a "gitdir:" file in the view points at it), so git
// works as usual. What the sandbox creates that is ignored (node_modules, build output) stays in the view; what is
// ignored in your project (.env, your node_modules) never enters the sandbox.
//
// Each file is compared on both sides with what both looked like after the last sync (size + time): a change on one
// side is copied to the other, a deletion is repeated, and a file changed on both sides keeps yours in the project and
// the sandbox's next to it as <name>.sandbox-conflict-<time><ext>. Copies keep the file time, so an unchanged file is
// never copied again. Links are never followed or created on either side.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { readValid, writeJsonAtomic } from '../../shared/io/index.js';
import { IgnoreRules } from './rules.js';

/** [host size, host time, view size, view time] after the last sync; -1 = no such file. */
type Seen = [number, number, number, number];
const Manifest = z.record(z.string().max(1024), z.tuple([z.number(), z.number(), z.number(), z.number()]));

export interface ViewPaths {
  /** The project on this PC. */
  host: string;
  /** Its filtered copy (mapped into the sandbox as the workspace). */
  view: string;
  /** Host-only: what both sides looked like after the last sync. */
  state: string;
}

export interface ViewOptions extends ViewPaths {
  exclude?: string[];
  include?: string[];
  /** The project's .git as the sandbox sees it (written into the view's .git file); null = the project has no .git. */
  guestGitDir?: string | null;
  note?: (message: string) => void;
}

export interface SyncStats {
  toView: number;
  toHost: number;
  deleted: number;
  conflicts: number;
  skipped: number;
}

/** Most entries one walk looks at: a sandbox can create files faster than they are worth syncing. */
const MAX_ENTRIES = 300000;

const stamp = (file: string): [number, number] => {
  try {
    const s = fs.lstatSync(file);
    return s.isFile() ? [s.size, Math.round(s.mtimeMs)] : [-1, -1];
  } catch {
    return [-1, -1];
  }
};

const sameContent = (a: string, b: string): boolean => {
  const hash = (f: string): string => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  try {
    return fs.statSync(a).size === fs.statSync(b).size && hash(a) === hash(b);
  } catch {
    return false;
  }
};

/** A path from an event or the manifest: relative, forward slashes, no way out of the root. */
const safeRel = (rel: string): string | null => {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.length > 1000 || clean.split('/').some((p) => p === '..' || p === '' || p.includes(':')))
    return null;
  return clean;
};

export class WorkspaceView {
  readonly rules: IgnoreRules;
  private seen: Record<string, Seen>;

  constructor(private readonly o: ViewOptions) {
    this.rules = new IgnoreRules(o.host, o.exclude, o.include);
    this.seen = readValid(Manifest, o.state) ?? {};
  }

  /** Where a project's view and its sync state live: <storage>\views\<id> and <storage>\views\<id>.json. */
  static pathsFor(storageRoot: string, host: string): ViewPaths {
    const id =
      path.basename(host).replace(/[^A-Za-z0-9._-]/g, '_') +
      '-' +
      crypto.createHash('sha256').update(path.resolve(host).toLowerCase()).digest('hex').slice(0, 8);
    const view = path.join(storageRoot, 'views', id);
    return { host, view, state: view + '.json' };
  }

  private abs(root: string, rel: string): string {
    return path.join(root, ...rel.split('/'));
  }

  /** Creates the view (with its .git file) and brings it fully in step with the project. */
  prepare(): SyncStats {
    fs.mkdirSync(this.o.view, { recursive: true });
    const gitFile = path.join(this.o.view, '.git');
    if (this.o.guestGitDir) fs.writeFileSync(gitFile, 'gitdir: ' + this.o.guestGitDir.replace(/\\/g, '/') + '\n');
    else fs.rmSync(gitFile, { force: true });
    return this.syncAll();
  }

  /** Every file not ignored, on one side (bounded, links skipped, ignored folders not entered). */
  private walk(root: string, under = ''): string[] {
    const files: string[] = [];
    // An ignored folder is only entered when one of your include patterns could match inside it; then only files those
    // patterns let in are taken.
    const queue: { rel: string; ignored: boolean }[] = [
      { rel: under, ignored: under !== '' && this.rules.isIgnored(under, true) },
    ];
    let count = 0;
    while (queue.length) {
      const { rel, ignored } = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(this.abs(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (++count > MAX_ENTRIES) {
          this.o.note?.('stopped listing ' + root + ' after ' + MAX_ENTRIES + ' entries');
          return files;
        }
        const child = rel ? rel + '/' + e.name : e.name;
        if (e.isSymbolicLink() || child === '.git') continue;
        if (e.isDirectory()) {
          const childIgnored = ignored || this.rules.isIgnoredChild(child, true);
          if (!childIgnored || this.rules.mayIncludeInside(child)) queue.push({ rel: child, ignored: childIgnored });
        } else if (e.isFile() && ((!ignored && !this.rules.isIgnoredChild(child, false)) || this.rules.isForced(child)))
          files.push(child);
      }
    }
    return files;
  }

  /** A full pass over both sides and everything synced before. */
  syncAll(): SyncStats {
    this.rules.reset();
    const all = new Set([...this.walk(this.o.host), ...this.walk(this.o.view), ...Object.keys(this.seen)]);
    return this.syncPaths(all);
  }

  /** Paths that changed (from file events): files, or folders whose contents are walked. */
  syncChanged(rels: Iterable<string>): SyncStats {
    const files = new Set<string>();
    for (const raw of rels) {
      const rel = safeRel(raw);
      if (!rel) continue;
      if (rel.endsWith('.gitignore')) {
        this.rules.reset();
        return this.syncAll();
      }
      const isDir = [this.o.host, this.o.view].some((root) => {
        try {
          return fs.lstatSync(this.abs(root, rel)).isDirectory();
        } catch {
          return false;
        }
      });
      if (isDir) {
        if (this.rules.isIgnored(rel, true) && !this.rules.mayIncludeInside(rel)) continue;
        for (const f of [...this.walk(this.o.host, rel), ...this.walk(this.o.view, rel)]) files.add(f);
        for (const k of Object.keys(this.seen)) if (k.startsWith(rel + '/')) files.add(k);
      } else files.add(rel);
    }
    return this.syncPaths(files);
  }

  private syncPaths(rels: Iterable<string>): SyncStats {
    const stats: SyncStats = { toView: 0, toHost: 0, deleted: 0, conflicts: 0, skipped: 0 };
    for (const rel of rels) {
      if (this.rules.isIgnored(rel)) {
        delete this.seen[rel];
        continue;
      }
      try {
        this.syncOne(rel, stats);
      } catch (e) {
        stats.skipped++;
        this.o.note?.('could not sync ' + rel + ': ' + (e instanceof Error ? e.message : String(e)));
      }
    }
    writeJsonAtomic(this.o.state, this.seen);
    return stats;
  }

  private syncOne(rel: string, stats: SyncStats): void {
    const hostFile = this.abs(this.o.host, rel);
    const viewFile = this.abs(this.o.view, rel);
    const [hs, hm] = stamp(hostFile);
    const [vs, vm] = stamp(viewFile);
    const before = this.seen[rel];
    const record = (): void => {
      const h = stamp(hostFile);
      const v = stamp(viewFile);
      if (h[0] < 0 && v[0] < 0) delete this.seen[rel];
      else this.seen[rel] = [h[0], h[1], v[0], v[1]];
    };
    if (hs < 0 && vs < 0) {
      delete this.seen[rel];
      return;
    }
    const hostChanged = !before || before[0] !== hs || before[1] !== hm;
    const viewChanged = !before || before[2] !== vs || before[3] !== vm;
    if (!hostChanged && !viewChanged) return;
    if (hostChanged && !viewChanged) {
      this.carry(hostFile, viewFile, hs < 0, stats, 'toView');
      record();
      return;
    }
    if (viewChanged && !hostChanged) {
      this.carry(viewFile, hostFile, vs < 0, stats, 'toHost');
      record();
      return;
    }
    // Changed on both sides (or never synced): the same content is no conflict.
    if (hs >= 0 && vs >= 0 && sameContent(hostFile, viewFile)) {
      record();
      return;
    }
    if (hs < 0) {
      this.carry(viewFile, hostFile, false, stats, 'toHost');
      record();
      return;
    }
    if (vs < 0) {
      this.carry(hostFile, viewFile, false, stats, 'toView');
      record();
      return;
    }
    // Yours stays in the project; the sandbox's version is kept next to it, and the view gets yours.
    const ext = path.extname(hostFile);
    const conflict =
      hostFile.slice(0, hostFile.length - ext.length) +
      '.sandbox-conflict-' +
      new Date().toISOString().replace(/\D/g, '').slice(0, 14) +
      ext;
    fs.copyFileSync(viewFile, conflict);
    this.carry(hostFile, viewFile, false, stats, 'toView');
    stats.conflicts++;
    this.o.note?.('both sides changed ' + rel + ": kept yours, the sandbox's version is " + path.basename(conflict));
    record();
  }

  /** Copies (keeping the file time) or deletes on the other side. */
  private carry(from: string, to: string, deleted: boolean, stats: SyncStats, way: 'toView' | 'toHost'): void {
    if (deleted) {
      if (stamp(to)[0] < 0) return;
      fs.rmSync(to, { force: true });
      this.pruneEmpty(path.dirname(to), way === 'toView' ? this.o.view : this.o.host);
      stats.deleted++;
      return;
    }
    // Never write through a link that is already there.
    try {
      if (fs.lstatSync(to).isSymbolicLink()) throw new Error('a link is in the way');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const t = fs.statSync(from).mtime;
    fs.utimesSync(to, t, t);
    stats[way]++;
  }

  private pruneEmpty(dir: string, root: string): void {
    for (let d = dir; d.length > root.length && d.startsWith(root); d = path.dirname(d)) {
      try {
        if (fs.readdirSync(d).length) return;
        fs.rmdirSync(d);
      } catch {
        return;
      }
    }
  }

  /**
   * Keeps both sides in step while it runs: file events from both, batched every 300 ms, plus a full pass every
   * `fullEveryMs` to catch anything an event missed. Returns a function that stops it.
   */
  watch(fullEveryMs = 60000): () => void {
    const pending = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    const flush = (): void => {
      timer = undefined;
      const batch = [...pending];
      pending.clear();
      const s = this.syncChanged(batch);
      if (s.toHost || s.toView || s.deleted || s.conflicts)
        this.o.note?.(
          'synced: ' + s.toView + ' in, ' + s.toHost + ' out, ' + s.deleted + ' deleted, ' + s.conflicts + ' conflicts',
        );
    };
    const onEvent = (_event: string, file: string | Buffer | null): void => {
      if (!file) return;
      pending.add(String(file));
      timer ??= setTimeout(flush, 300);
    };
    const watchers = [this.o.host, this.o.view].map((dir) => fs.watch(dir, { recursive: true }, onEvent));
    const full = setInterval(() => {
      try {
        this.syncAll();
      } catch (e) {
        this.o.note?.('full sync failed: ' + (e instanceof Error ? e.message : String(e)));
      }
    }, fullEveryMs);
    return () => {
      watchers.forEach((w) => w.close());
      clearInterval(full);
      clearTimeout(timer);
      if (pending.size) flush();
    };
  }
}
