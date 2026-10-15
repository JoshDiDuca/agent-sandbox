// Where contained storage keeps its files, and how the data set splits when it is on: `run\` stays the plain host
// folder (the host reads it), the folders listed here live in the disk image and are mapped from inside its mount
// folder to the very same guest paths the whole data folder had.
import path from 'node:path';
import type { ResolvedMapping } from '../../../core/types.js';
import { fail } from '../../../core/util/index.js';

/** The folders of the data set that move into the image. Everything else of the data set stays on the PC as it is. */
export const CONTAINED_FOLDERS = ['tools', 'state', 'logs', 'databases', 'cache'] as const;
export type ContainedFolder = (typeof CONTAINED_FOLDERS)[number];

/** A data set name the scripts accept (same as the dataName setting, so every real name passes). */
export const SET_NAME_RULE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ContainedPaths {
  readonly storageRoot: string;
  readonly set: string;
  readonly imagesDir: string;
  readonly mountsDir: string;
  /** <storage>\images\<set>.vhdx */
  readonly image: string;
  /** <storage>\mounts\<set> */
  readonly mount: string;
  /** <storage>\mounts\state.json: which sets are mounted and who holds them (never inside an image). */
  readonly stateFile: string;
  readonly lockFile: string;
}

export function containedPaths(storageRoot: string, set: string): ContainedPaths {
  if (!SET_NAME_RULE.test(set))
    fail('The data set name "' + set + '" cannot be used for contained storage.', 'Use letters, numbers, - and _.');
  const root = path.resolve(storageRoot);
  const imagesDir = path.join(root, 'images');
  const mountsDir = path.join(root, 'mounts');
  return {
    storageRoot: root,
    set,
    imagesDir,
    mountsDir,
    image: path.join(imagesDir, set + '.vhdx'),
    mount: path.join(mountsDir, set),
    stateFile: path.join(mountsDir, 'state.json'),
    lockFile: path.join(mountsDir, 'state.lock'),
  };
}

/** The data set's name: the last folder of <storage>\data\<name>. */
export function setNameOf(dataPath: string): string {
  return path.basename(path.resolve(dataPath));
}

/**
 * The mappings for a data set with contained storage: the run folder from the data folder on the PC, each contained
 * folder from the mounted image. The guest sees C:\AgentData\run, \tools, \state, ... exactly as with one mapping of
 * the whole folder.
 */
export function containedMappings(dataPath: string, mount: string, guestData: string): ResolvedMapping[] {
  return [
    { host: path.join(dataPath, 'run'), guest: guestData + '\\run', readOnly: false },
    ...CONTAINED_FOLDERS.map((name) => ({
      host: path.join(mount, name),
      guest: guestData + '\\' + name,
      readOnly: false,
    })),
  ];
}
