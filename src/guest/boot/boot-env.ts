// What the boot's provisioning left for projects that join later: the PATH before any toolchain was added, which
// variables the toolchains set, and what each step contributed. Kept on the sandbox's own disk (lost on close, as it
// should be). The session daemon builds every later project's environment from it instead of from the boot
// project's, so project A's Node, Rust target folder or database variables never leak into project B's sessions.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { localDir } from '../runtime/paths.js';
import { BootEnvSchema, type BootEnv } from './project-env.js';

export { baseEnvFor, type BootEnv } from './project-env.js';

const file = (): string => path.join(localDir, 'boot-env.json');

export const saveBootEnv = (value: BootEnv): void => {
  try {
    writeJsonAtomic(file(), value);
  } catch {
    /* projects added later then fall back to the boot environment */
  }
};

export const readBootEnv = (): BootEnv | null => {
  try {
    return BootEnvSchema.safeParse(JSON.parse(fs.readFileSync(file(), 'utf8'))).data ?? null;
  } catch {
    return null;
  }
};
