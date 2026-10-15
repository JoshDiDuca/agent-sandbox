// Moving the storage root (everything kept between sandboxes) to another folder: measuring, estimating, checking, and
// the move itself (rename on the same drive, a verified copy otherwise). The folder is pinned as storage.root in the
// user's config at the end, so an older version still finds it. Returns data and calls back; never prints.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DEFAULTS } from '../../core/config/index.js';
import { freeBytesAt, GB, humanBytes } from '../../core/disk.js';
import { errMsg, expandPath, fail, isInsideOrEqual, isLink, isRootPath } from '../../core/util/index.js';
import { safeRemove } from '../../shared/io/index.js';
import { setValue } from '../migrate/migrations/config-file.js';
import { ensureStorageRoot, OLD_DEFAULT_ROOT, oldDefaultRoot } from './root.js';

/** A copy is estimated at this speed, plus a cost per file (small files are slower than big ones). */
export const COPY_BYTES_PER_SECOND = 80 * 1024 * 1024;
export const COPY_SECONDS_PER_FILE = 0.002;
/** Above these a move is called big: the dialog and the command warn. */
export const BIG_BYTES = 5 * GB;
export const BIG_FILES = 200_000;
/** Measuring stops after this long or this many entries and reports "at least". */
export const MEASURE_MS = 20_000;
export const MEASURE_ENTRIES = 3_000_000;
/** Files from this size on are copied as a stream, so progress moves while one big file copies. */
const STREAM_FROM_BYTES = 64 * 1024 * 1024;

/** Used when no way to make a folder private was given: a shared-tree target is refused rather than left open. */
const refuseUnprotected = (dir: string): void =>
  fail('Cannot make ' + dir + ' private here.', 'Move the data with sandbox storage move on your PC.');

export interface Measured {
  readonly bytes: number;
  readonly files: number;
  /** The walk stopped at its limit: the real size is at least this. */
  readonly partial: boolean;
}

export interface MoveEstimate {
  /** The same drive: folders are renamed, nothing is copied. */
  readonly sameVolume: boolean;
  readonly seconds: number;
  readonly freeBytes: number | null;
  /** Room on the target drive (always true for a rename). */
  readonly fits: boolean;
  readonly big: boolean;
}

export interface MoveProgress {
  readonly bytes: number;
  readonly files: number;
}

export interface MoveOptions {
  /** Copy even on the same drive (tests, and --keep-old which needs the old folder to stay). */
  readonly forceCopy?: boolean;
  readonly keepOld?: boolean;
  readonly onProgress?: (progress: MoveProgress) => void;
}

export interface MoveResult {
  readonly from: string;
  readonly to: string;
  readonly copied: boolean;
  readonly files: number;
  readonly bytes: number;
  /** What was stored as storage.root. */
  readonly pinned: string;
  /** The old folder is gone (false with keepOld, when links were left in it, or when removing failed). */
  readonly removedOld: boolean;
  readonly notes: readonly string[];
}

/** Size and file count, never following links or junctions, with a time and entry limit. */
export function measureFolder(root: string, maxMs = MEASURE_MS, maxEntries = MEASURE_ENTRIES): Measured {
  const deadline = Date.now() + maxMs;
  let bytes = 0;
  let files = 0;
  let entries = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // gone or unreadable: counts as nothing
    }
    for (const entry of list) {
      if (++entries > maxEntries || (entries % 512 === 0 && Date.now() > deadline))
        return { bytes, files, partial: true };
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        bytes += fs.lstatSync(full).size;
        files++;
      } catch {
        // vanished while measuring
      }
    }
  }
  return { bytes, files, partial: false };
}

/** Do both folders (the target may not exist yet) sit on the same volume? */
export function sameVolume(from: string, to: string): boolean {
  const near = (p: string): string => {
    let at = path.resolve(p);
    while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
    return at;
  };
  const a = near(from);
  const b = near(to);
  if (path.parse(a).root.toLowerCase() !== path.parse(b).root.toLowerCase()) return false;
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false;
  }
}

/** The pure part of the estimate: time, room and whether it is big. `freeBytes` null = unknown (assumed enough). */
export function estimateMove(measured: Measured, same: boolean, freeBytes: number | null): MoveEstimate {
  const seconds = same
    ? Math.max(1, Math.ceil(measured.files / 50_000))
    : Math.ceil(measured.bytes / COPY_BYTES_PER_SECOND + measured.files * COPY_SECONDS_PER_FILE);
  const fits = same || freeBytes === null || freeBytes > measured.bytes * 1.02 + 64 * 1024 * 1024;
  return {
    sameVolume: same,
    seconds,
    freeBytes,
    fits,
    big: measured.bytes > BIG_BYTES || measured.files > BIG_FILES,
  };
}

export function estimate(from: string, to: string, measured: Measured, copyOnly = false): MoveEstimate {
  const same = !copyOnly && sameVolume(from, to);
  return estimateMove(measured, same, same ? null : freeBytesAt(to));
}

/** "about 3 minutes", "a few seconds". */
export function describeDuration(seconds: number): string {
  if (seconds < 10) return 'a few seconds';
  if (seconds < 90) return 'about ' + Math.round(seconds / 10) * 10 + ' seconds';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return 'about ' + minutes + ' minutes';
  const hours = Math.round(seconds / 360) / 10;
  return 'about ' + hours + ' hours';
}

/** "12.3 GB, 412,000 files", with "at least" when the measuring stopped early. */
export function describeSize(measured: Measured): string {
  return (
    (measured.partial ? 'at least ' : '') +
    humanBytes(measured.bytes) +
    ', ' +
    measured.files.toLocaleString('en-US') +
    ' files'
  );
}

/** A warning line for a big or too-big move, or null. */
export function moveWarning(measured: Measured, est: MoveEstimate): string | null {
  if (!est.fits)
    return (
      'The target drive has ' +
      (est.freeBytes === null ? 'too little' : humanBytes(est.freeBytes)) +
      ' free; this needs ' +
      humanBytes(measured.bytes) +
      ' and some room to spare.'
    );
  if (est.big)
    return (
      'This is a lot of data (' + describeSize(measured) + '): the move takes ' + describeDuration(est.seconds) + '.'
    );
  return null;
}

/** What to store in config.json for this folder: the %VARIABLE% form when it is a default, else the full path. */
export function pinValue(folder: string, env: NodeJS.ProcessEnv = process.env): string {
  const same = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const shared = expandPath(DEFAULTS.storage.root, process.cwd());
  if (same(folder, shared)) return DEFAULTS.storage.root;
  const old = oldDefaultRoot(env);
  if (old && same(folder, old)) return OLD_DEFAULT_ROOT;
  return path.resolve(folder);
}

/** Why `from` -> `to` is not allowed, or null. `allowNonEmpty`: the target may hold data already (switching to it). */
export function moveProblem(from: string, to: string, allowNonEmpty = false): { message: string; fix: string } | null {
  const a = path.resolve(from);
  const b = path.resolve(to);
  if (!path.isAbsolute(to)) return { message: to + ' is not a full path.', fix: 'Give a path like D:\\Sandbox.' };
  if (isRootPath(b)) return { message: b + ' is a whole drive.', fix: 'Pick a folder on it, e.g. ' + b + 'Sandbox.' };
  if (a.toLowerCase() === b.toLowerCase()) return { message: 'Your data is in that folder already.', fix: '' };
  if (isInsideOrEqual(a, b))
    return { message: 'The new folder is inside the old one.', fix: 'Pick a folder outside ' + a + '.' };
  if (isInsideOrEqual(b, a))
    return { message: 'The old folder is inside the new one.', fix: 'Pick a folder that does not contain ' + a + '.' };
  if (isLink(b) || isLink(path.dirname(b)))
    return { message: b + ' (or the folder above it) is a link.', fix: 'Pick a plain folder.' };
  if (fs.existsSync(b)) {
    let entries: string[] = [];
    try {
      if (!fs.statSync(b).isDirectory()) return { message: b + ' is a file.', fix: 'Pick a folder.' };
      entries = fs.readdirSync(b);
    } catch (e) {
      return { message: 'Cannot look into ' + b + ': ' + errMsg(e), fix: 'Pick another folder.' };
    }
    if (entries.length && !allowNonEmpty) return { message: b + ' is not empty.', fix: 'Pick an empty or new folder.' };
  }
  return null;
}

export class StorageMove {
  /**
   * @param configFile the user's config.json (created if needed): storage.root is pinned in it
   * @param busy why a move cannot happen now (a background job on the old folder), or null
   */
  constructor(
    private readonly configFile: string,
    private readonly busy: () => string | null,
    /** Whether a sandbox runs on this PC (given by the caller: host/sandbox imports this folder). */
    private readonly sandboxRunning: () => boolean,
    private readonly protect?: (dir: string) => void,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Throws a UserError when this move is not possible right now. */
  validate(from: string, to: string): void {
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory())
      fail('There is no folder to move: ' + from + ' does not exist.');
    if (isLink(from)) fail(from + ' is a link.', 'Move the real folder, not a link.');
    const problem = moveProblem(from, to);
    if (problem) fail(problem.message, problem.fix || undefined);
    if (this.sandboxRunning()) fail('A Windows Sandbox is running.', 'Close it (sandbox stop), then move your data.');
    const why = this.busy();
    if (why) fail(why, 'Wait a minute, then try again.');
  }

  async move(from: string, to: string, options: MoveOptions = {}): Promise<MoveResult> {
    this.validate(from, to);
    const target = path.resolve(to);
    const source = path.resolve(from);
    const measured = measureFolder(source);
    const est = estimate(source, target, measured, Boolean(options.forceCopy || options.keepOld));
    if (!est.fits) fail(moveWarning(measured, est) ?? 'Not enough room.', 'Free some space or pick another drive.');
    const existedBefore = fs.existsSync(target);
    const notes: string[] = [];
    let copiedFiles = measured.files;
    let copiedBytes = measured.bytes;
    let skippedLinks = 0;
    let renamed = false;
    try {
      this.prepare(target);
      if (est.sameVolume) {
        this.rename(source, target);
        renamed = true;
      } else {
        const done = await this.copy(source, target, options.onProgress);
        copiedFiles = done.files;
        copiedBytes = done.bytes;
        skippedLinks = done.links;
      }
      this.pin(target);
    } catch (e) {
      // Back to how it was: the old folder is whole again, the config is untouched, what was made in the target goes.
      if (renamed) this.undoRename(source, target);
      this.discard(target, existedBefore);
      throw e;
    }
    let removedOld = false;
    if (est.sameVolume) removedOld = this.removeEmpty(source, notes);
    else if (options.keepOld) notes.push('The old folder is kept: ' + source);
    else if (skippedLinks)
      notes.push('The old folder is kept because it holds ' + skippedLinks + ' link(s): ' + source);
    else removedOld = this.removeOld(source, notes);
    return {
      from: source,
      to: target,
      copied: !est.sameVolume,
      files: copiedFiles,
      bytes: copiedBytes,
      pinned: pinValue(target, this.env),
      removedOld,
      notes,
    };
  }

  /** Writes storage.root without moving anything (sandbox storage use). */
  pin(target: string): void {
    setValue(this.configFile, ['storage', 'root'], pinValue(target, this.env));
  }

  /** Creates the target, private when it is under the users folder, before anything is written in it. */
  private prepare(target: string): void {
    ensureStorageRoot(target, this.protect ?? refuseUnprotected, this.env);
  }

  private rename(source: string, target: string): void {
    const moved: string[] = [];
    try {
      for (const name of fs.readdirSync(source)) {
        fs.renameSync(path.join(source, name), path.join(target, name));
        moved.push(name);
      }
    } catch (e) {
      for (const name of moved.reverse()) {
        try {
          fs.renameSync(path.join(target, name), path.join(source, name));
        } catch {
          // best effort: the message below says where the rest is
        }
      }
      fail(
        'Moving stopped: ' + errMsg(e),
        'Nothing was changed. Close programs that use ' + source + ' and try again.',
      );
    }
  }

  private undoRename(source: string, target: string): void {
    for (const name of fs.readdirSync(target)) {
      try {
        fs.renameSync(path.join(target, name), path.join(source, name));
      } catch {
        // best effort
      }
    }
  }

  private async copy(
    source: string,
    target: string,
    onProgress?: (p: MoveProgress) => void,
  ): Promise<{ bytes: number; files: number; links: number }> {
    const done = { bytes: 0, files: 0, links: 0 };
    let lastReport = 0;
    const report = (force = false): void => {
      if (!onProgress || (!force && Date.now() - lastReport < 200)) return;
      lastReport = Date.now();
      onProgress({ bytes: done.bytes, files: done.files });
    };
    const walk = async (from: string, to: string): Promise<void> => {
      await fs.promises.mkdir(to, { recursive: true });
      for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
        const a = path.join(from, entry.name);
        const b = path.join(to, entry.name);
        if (entry.isSymbolicLink()) {
          done.links++;
          continue;
        }
        if (entry.isDirectory()) {
          await walk(a, b);
          continue;
        }
        const stat = await fs.promises.stat(a);
        if (stat.size >= STREAM_FROM_BYTES) {
          const before = done.bytes;
          const input = fs.createReadStream(a);
          input.on('data', () => {
            done.bytes = before + input.bytesRead;
            report();
          });
          await pipeline(input, fs.createWriteStream(b));
          done.bytes = before;
        } else await fs.promises.copyFile(a, b);
        const copied = await fs.promises.stat(b);
        if (copied.size !== stat.size) fail('The copy of ' + a + ' has another size than the original.');
        await fs.promises.utimes(b, stat.atime, stat.mtime);
        done.bytes += stat.size;
        done.files++;
        report();
      }
    };
    await walk(source, target);
    report(true);
    return done;
  }

  /** Failure cleanup: removes what a failed copy left, never the old folder. */
  private discard(target: string, existedBefore: boolean): void {
    try {
      if (!existedBefore) safeRemove(target, path.dirname(target));
      else for (const name of fs.readdirSync(target)) safeRemove(path.join(target, name), target);
    } catch {
      // the original error is the one to show; a leftover partial folder is only wasted space
    }
  }

  private removeOld(source: string, notes: string[]): boolean {
    try {
      safeRemove(source, path.dirname(source));
      if (!fs.existsSync(source)) return true;
      notes.push('Some of the old folder could not be removed: ' + source);
    } catch (e) {
      notes.push('The old folder could not be removed (' + errMsg(e) + '): ' + source);
    }
    return false;
  }

  private removeEmpty(source: string, notes: string[]): boolean {
    try {
      fs.rmdirSync(source);
      return true;
    } catch (e) {
      notes.push('The old folder is still there (' + errMsg(e) + '): ' + source);
      return false;
    }
  }
}
