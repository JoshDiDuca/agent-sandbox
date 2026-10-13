// Clean-up of what interrupted or older installs left in the tools folder.
import fs from 'node:fs';
import path from 'node:path';
import { safeRemove } from '../../shared/safe-remove.js';
import { toolsDir } from '../env.js';

const STAGING = /\.staging-[0-9a-f]+$/i;
const entries = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** Removes helper builds older versions left in persistent storage, and interrupted installs' staging folders. */
export const pruneToolLeftovers = (): void => {
  for (const legacy of ['ptyhost', 'gitshim']) safeRemove(path.join(toolsDir, legacy), toolsDir);
  // Staging folders sit next to their destination: tools\x.staging-ab12 and one level down (tools\nvm\v22.staging-ab12).
  for (const top of entries(toolsDir)) {
    const dir = path.join(toolsDir, top.name);
    if (STAGING.test(top.name)) safeRemove(dir, toolsDir);
    else if (top.isDirectory())
      for (const sub of entries(dir).filter((e) => STAGING.test(e.name))) safeRemove(path.join(dir, sub.name), dir);
  }
};
