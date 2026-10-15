// The storage root (everything kept between sandboxes): where the old and the new default are, which folders may hold
// saved data, and the one place that creates the root (private when it is under %ProgramData%\AgentSandbox\users).
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, machineRoot } from '../../core/config/index.js';
import { expandPath, fail, isInsideOrEqual, isLink } from '../../core/util/index.js';

/** Where the data lived before 1.6: per user, in the profile. Still pinned in config.json when it was there. */
export const OLD_DEFAULT_ROOT = '%LOCALAPPDATA%\\AgentSandbox';

/** The old per-user default, expanded (null when LOCALAPPDATA is not set). */
export function oldDefaultRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'AgentSandbox') : null;
}

/** The shared default, expanded: %ProgramData%\AgentSandbox\users\<you>. */
export function sharedDefaultRoot(base: string = process.cwd()): string {
  return expandPath(DEFAULTS.storage.root, base);
}

/** The folder that holds one private storage folder per user. */
export function usersFolder(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(machineRoot(env), 'users');
}

/** The per-user folder under the users folder that `root` is (or is inside), or null when it is elsewhere. */
export function privateFolderOf(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const users = usersFolder(env);
  const resolved = path.resolve(root);
  if (!isInsideOrEqual(users, resolved) || resolved.toLowerCase() === path.resolve(users).toLowerCase()) return null;
  const first = path.relative(path.resolve(users), resolved).split(path.sep)[0];
  return path.join(users, first);
}

/** A folder with something in it (a missing folder, a file or an empty folder holds no data). */
export function holdsData(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Creates the storage root when it is missing. Under %ProgramData%\AgentSandbox\users the folder is made private
 * before anything is written in it (the users folder itself is created as you when no all-users install made it). A
 * root elsewhere is made private when this call creates it.
 */
export function ensureStorageRoot(
  root: string,
  protect: (dir: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const priv = privateFolderOf(root, env);
  if (fs.existsSync(root)) {
    // Made by hand and still empty: private before anything lands in it.
    if (priv && !holdsData(root)) protect(priv);
    return;
  }
  if (!priv) {
    // A root of your own choosing is made private too, but only when this call creates it (never an existing folder,
    // so a tree that already holds files is not walked) and never a drive root.
    const created = fs.mkdirSync(root, { recursive: true });
    if (created && path.dirname(path.resolve(root)) !== path.resolve(root)) {
      try {
        protect(root);
      } catch {
        // Drives without permissions (FAT, some network shares) cannot be made private: the folder is still used.
      }
    }
    return;
  }
  fs.mkdirSync(path.dirname(priv), { recursive: true });
  if (isLink(path.dirname(priv))) fail('The folder ' + path.dirname(priv) + ' is a link.', 'Remove the link first.');
  fs.mkdirSync(priv, { recursive: true });
  try {
    protect(priv);
  } catch (e) {
    fail(
      'Could not make ' + priv + ' private: ' + (e instanceof Error ? e.message : String(e)),
      'Run sandbox storage move <folder> to keep your data somewhere else, or report this.',
    );
  }
  fs.mkdirSync(root, { recursive: true });
}
