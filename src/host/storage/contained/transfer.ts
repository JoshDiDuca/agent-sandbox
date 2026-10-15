// Moving the data set's folders into the image (contained storage on) and back out to plain folders (off). The copy is
// verified file by file; the originals are removed only after every folder was copied completely, and a link found
// in a folder is never followed (that folder is then left where it is).
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { freeBytesAt } from '../../../core/disk.js';
import { fail, isLink } from '../../../core/util/index.js';
import { safeRemove } from '../../../shared/io/index.js';
import { estimateMove, measureFolder, type Measured, type MoveEstimate, type MoveProgress } from '../move.js';
import { CONTAINED_FOLDERS } from './layout.js';

const STREAM_FROM_BYTES = 64 * 1024 * 1024;

export interface TransferFolder {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly measured: Measured;
}

export interface TransferPlan {
  readonly folders: readonly TransferFolder[];
  readonly total: Measured;
  readonly estimate: MoveEstimate;
}

export interface TransferResult {
  readonly files: number;
  readonly bytes: number;
  /** Folders whose original was kept (a link inside, or the folder could not be removed), with the reason. */
  readonly notes: readonly string[];
}

const plainFolder = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory() && !isLink(dir);
  } catch {
    return false;
  }
};

const holdsFiles = (dir: string): boolean => {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
};

/** What would move: each contained folder that exists in `fromRoot` and holds something, with its size and the time. */
export function planTransfer(
  fromRoot: string,
  toRoot: string,
  freeBytesRoot: string,
  measure: (dir: string) => Measured = measureFolder,
): TransferPlan {
  const folders: TransferFolder[] = [];
  for (const name of CONTAINED_FOLDERS) {
    const from = path.join(fromRoot, name);
    if (!plainFolder(from) || !holdsFiles(from)) continue;
    folders.push({ name, from, to: path.join(toRoot, name), measured: measure(from) });
  }
  const total: Measured = {
    bytes: folders.reduce((n, f) => n + f.measured.bytes, 0),
    files: folders.reduce((n, f) => n + f.measured.files, 0),
    partial: folders.some((f) => f.measured.partial),
  };
  return { folders, total, estimate: estimateMove(total, false, freeBytesAt(freeBytesRoot)) };
}

/** Refuses a target folder that already holds files (nothing is ever merged or overwritten). */
export function assertTargetsFree(plan: TransferPlan): void {
  for (const f of plan.folders)
    if (fs.existsSync(f.to) && holdsFiles(f.to))
      fail(f.to + ' already holds files.', 'Move or delete them first, then run the command again.');
}

/** Copies every folder of the plan, checks sizes and counts, then removes the originals. `root` bounds the removal. */
export async function runTransfer(
  plan: TransferPlan,
  root: string,
  onProgress?: (p: MoveProgress) => void,
): Promise<TransferResult> {
  assertTargetsFree(plan);
  const done = { bytes: 0, files: 0, links: 0 };
  const linkFolders = new Set<string>();
  let last = 0;
  const report = (force = false): void => {
    if (!onProgress || (!force && Date.now() - last < 200)) return;
    last = Date.now();
    onProgress({ bytes: done.bytes, files: done.files });
  };
  const walk = async (from: string, to: string, folder: string): Promise<void> => {
    await fs.promises.mkdir(to, { recursive: true });
    for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
      const a = path.join(from, entry.name);
      const b = path.join(to, entry.name);
      if (entry.isSymbolicLink()) {
        linkFolders.add(folder);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(a, b, folder);
        continue;
      }
      const stat = await fs.promises.stat(a);
      if (stat.size >= STREAM_FROM_BYTES) await pipeline(fs.createReadStream(a), fs.createWriteStream(b));
      else await fs.promises.copyFile(a, b);
      const copied = await fs.promises.stat(b);
      if (copied.size !== stat.size) fail('The copy of ' + a + ' has another size than the original.');
      await fs.promises.utimes(b, stat.atime, stat.mtime);
      done.bytes += stat.size;
      done.files++;
      report();
    }
  };
  for (const f of plan.folders) await walk(f.from, f.to, f.name);
  report(true);
  const notes: string[] = [];
  for (const f of plan.folders) {
    const copied = measureFolder(f.to);
    if (!f.measured.partial && copied.files < f.measured.files)
      fail(
        'The copy of ' +
          f.name +
          ' has fewer files than the original (' +
          copied.files +
          ' of ' +
          f.measured.files +
          ').',
        'Nothing was removed. Run the command again.',
      );
  }
  // Only now, with everything copied, do the originals go.
  for (const f of plan.folders) {
    if (linkFolders.has(f.name)) {
      notes.push(f.from + ' has links in it, which are not copied; it was left where it is.');
      continue;
    }
    try {
      safeRemove(f.from, root);
      if (fs.existsSync(f.from)) notes.push(f.from + ' could not be removed completely; delete it by hand.');
    } catch (e) {
      notes.push(f.from + ' could not be removed (' + (e instanceof Error ? e.message : String(e)) + ').');
    }
  }
  return { files: done.files, bytes: done.bytes, notes };
}
