import fs from 'node:fs';
import path from 'node:path';
import { exeMatcher } from '../../shared/apps/index.js';

const MAX_DEPTH = 7;
const MAX_ENTRIES = 50000;
/** A folder for 64-bit x86 builds (zips that ship amd64\ and i386\ copies of the same program). */
const X64_FOLDER = /(^|[\\/])(amd64|x64|x86_64|win64)([\\/]|$)/i;

/**
 * The program in an installed folder (breadth first, bounded: big apps have tens of thousands of files). Of several
 * copies at the same depth, one in an amd64/x64 folder wins.
 */
export function findExe(root: string, exe: string): string | null {
  const match = exeMatcher(exe);
  const best = (hits: readonly string[]): string | null =>
    hits.find((h) => X64_FOLDER.test(path.relative(root, h))) ?? hits[0] ?? null;
  let queue = [root];
  let seen = 0;
  for (let depth = 0; depth < MAX_DEPTH && queue.length; depth++) {
    const next: string[] = [];
    const hits: string[] = [];
    for (const dir of queue) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const hit = entries.find((e) => e.isFile() && match(e.name));
      if (hit) hits.push(path.join(dir, hit.name));
      else
        next.push(...entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => path.join(dir, e.name)));
      if ((seen += entries.length) > MAX_ENTRIES) return best(hits);
    }
    if (hits.length) return best(hits);
    queue = next;
  }
  return null;
}
