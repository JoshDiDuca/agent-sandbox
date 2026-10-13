import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { assertTestWritable } from '../test-guard.js';

/** Anything bigger than this from the other side is ignored (a compromised sandbox must not exhaust the host). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export const readJsonFile = <T>(file: string): T | null => {
  try {
    if (fs.statSync(file).size > MAX_MESSAGE_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T;
  } catch {
    return null;
  }
};

/** Reads and validates; a missing, oversized or malformed file is simply absent. */
export const readValid = <S extends z.ZodType>(schema: S, file: string): z.output<S> | null => {
  const parsed = schema.safeParse(readJsonFile<unknown>(file));
  return parsed.success ? parsed.data : null;
};

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Write to a uniquely named temp file and rename, so a reader on the other side of the mapped folder never sees half a
 * file. The rename is retried briefly: antivirus or the other side's reader can hold the target for a moment.
 */
export const writeJsonAtomic = (file: string, value: unknown): void =>
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');

/** Same for any text file (two commands at once, or a watcher and a command, never leave a half-written file). */
export const writeFileAtomic = (file: string, text: string): void => {
  assertTestWritable(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '-' + Math.random().toString(36).slice(2) + '.tmp';
  fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        fs.rmSync(temp, { force: true });
        throw e;
      }
      pause(50 * attempt);
    }
  }
};
