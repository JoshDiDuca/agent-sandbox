// Where the host finds the data set's folders. Plain data folder: <data>\<name>. While contained storage has the image
// mounted: <storage>\mounts\<set>\<name>, but only when that folder really is another volume (a stale record must
// never send a write into an empty folder on this PC's own disk).
import fs from 'node:fs';
import path from 'node:path';
import { JsonFile } from '../../../shared/io/index.js';
import { containedPaths, type ContainedFolder } from './layout.js';
import { ContainedStateSchema } from './state.js';

/** The folder that holds tools, state, logs ...: the mount folder while the image is mounted, else the data folder. */
export function hostDataRoot(dataPath: string): string {
  try {
    const set = path.basename(dataPath);
    const paths = containedPaths(path.dirname(path.dirname(dataPath)), set);
    if (!fs.existsSync(paths.stateFile)) return dataPath;
    const state = new JsonFile(ContainedStateSchema, paths.stateFile).read();
    if (!state?.sets[set]?.mounted) return dataPath;
    if (fs.statSync(paths.mount).dev === fs.statSync(paths.mountsDir).dev) return dataPath;
    return paths.mount;
  } catch {
    // No contained storage here (or an unreadable record): the plain folder is the answer.
    return dataPath;
  }
}

export function hostDataFolder(dataPath: string, name: ContainedFolder): string {
  return path.join(hostDataRoot(dataPath), name);
}
