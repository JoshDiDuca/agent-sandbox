import fs from 'node:fs';
import path from 'node:path';
import { exeMatcher } from '../../shared/apps/index.js';

/** The program in an installed folder (breadth first, bounded: big apps have tens of thousands of files). */
export function findExe(root: string, exe: string): string | null {
  const match = exeMatcher(exe);
  let queue = [root];
  let seen = 0;
  for (let depth = 0; depth < 7 && queue.length; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const hit = entries.find((e) => e.isFile() && match(e.name));
      if (hit) return path.join(dir, hit.name);
      next.push(...entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => path.join(dir, e.name)));
      if ((seen += entries.length) > 50000) return null;
    }
    queue = next;
  }
  return null;
}
