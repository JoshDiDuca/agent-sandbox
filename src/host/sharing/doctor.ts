// Doctor rows for an all-users install: can this user read the settings for the PC and write the data folder.
import fs from 'node:fs';
import path from 'node:path';
import { machineConfigPath } from '../../core/config/index.js';
import { errMsg } from '../../core/util/index.js';
import { sharingDeps } from './lifecycle.js';

/** "readable", "not there" or the reason it cannot be read. */
function readableText(file: string): string {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return 'readable';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'none (built-in defaults apply)';
    return 'NOT readable (' + errMsg(e) + '). Sign out of Windows and in again after being added to the group';
  }
}

/** "writable" or why not: a small file is created and removed in the folder (made first when it is missing). */
function writableText(dir: string): string {
  const probe = path.join(dir, '.write-test-' + process.pid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, '');
    return 'writable';
  } catch (e) {
    return 'NOT writable (' + errMsg(e) + ')';
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

/** The extra doctor rows of an all-users install; none for any other install. */
export function machineDoctorRows(packageRoot: string, dataPath: string): [string, string][] {
  if (!sharingDeps(packageRoot)) return [];
  const file = machineConfigPath();
  return [
    ['Settings for this PC', file + ': ' + readableText(file)],
    ['Data folder access', dataPath + ': ' + writableText(dataPath)],
  ];
}
