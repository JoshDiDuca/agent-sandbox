// Which folders may be shared with the sandbox. The agent gets read/write access to what is mapped, so nothing that
// would let it reach this tool, its storage, your settings or the OS may be mapped.
import { userDir } from './config/index.js';
import { fail, isInsideOrEqual, isRootPath, isUserProfile } from './util/index.js';

/** Folders the agent must never be able to write: the tool itself, its storage and your settings for it. */
const protectedFolders = (packageRoot: string, storageRoot: string): [string, string][] => [
  ["this tool's install folder", packageRoot],
  ['the sandbox storage folder', storageRoot],
  ['your sandbox settings folder', userDir()],
];

/** A read/write folder mapped into the sandbox must not contain, or sit inside, any protected folder. */
export function assertSafeMapping(folder: string, packageRoot: string, storageRoot: string): void {
  if (isRootPath(folder) || isUserProfile(folder))
    fail(
      'A whole drive or user profile cannot be mapped into the sandbox: ' + folder,
      'Map a specific folder instead.',
    );
  for (const [label, dir] of protectedFolders(packageRoot, storageRoot)) {
    if (isInsideOrEqual(dir, folder) || isInsideOrEqual(folder, dir))
      fail(
        folder + ' cannot be mapped into the sandbox: it overlaps ' + label + ' (' + dir + ').',
        'Map a folder that is not inside (and does not contain) ' + dir + '.',
      );
  }
}

/**
 * The agent gets read/write access to the workspace, so refuse folders that would let it reach the tool itself, its
 * storage, or the OS.
 */
export function assertSafeWorkspace(workspace: string, packageRoot: string, storageRoot: string): void {
  if (isRootPath(workspace))
    fail(
      'A whole drive cannot be the workspace: ' + workspace,
      'Run sandbox claude from a project folder (or pass --workspace <folder>).',
    );
  if (isUserProfile(workspace))
    fail(
      'Your whole user profile cannot be the workspace: ' + workspace,
      'Run sandbox claude from a project folder (or pass --workspace <folder>).',
    );
  for (const [label, dir] of protectedFolders(packageRoot, storageRoot)) {
    if (isInsideOrEqual(dir, workspace))
      fail(
        workspace +
          ' cannot be the workspace: it is inside ' +
          label +
          ' (' +
          dir +
          '), so the agent could change the code that runs on this PC.',
        dir === packageRoot
          ? 'Developing windows-development-sandbox itself? Install it as a copy instead of a link: run `npm run install:global` in the repository, then sandbox claude works there.'
          : 'Run sandbox claude from a project folder somewhere else.',
      );
    if (isInsideOrEqual(workspace, dir))
      fail(
        workspace +
          ' cannot be the workspace: it contains ' +
          label +
          ' (' +
          dir +
          '), which the agent must not be able to change.',
        'Run sandbox claude from a project folder that does not contain it.',
      );
  }
  for (const name of ['WINDIR', 'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const dir = process.env[name];
    if (dir && isInsideOrEqual(dir, workspace))
      fail('A system folder cannot be the workspace: ' + workspace, 'Run sandbox claude from a project folder.');
  }
}
