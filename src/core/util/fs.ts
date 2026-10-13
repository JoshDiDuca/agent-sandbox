import fs from 'node:fs';
import { writeJsonAtomic } from '../../shared/io/index.js';

export const ensureDir = (p: string): void => {
  fs.mkdirSync(p, { recursive: true });
};
export const dirExists = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
export const fileExists = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
export const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as T;
export const tryReadJson = <T>(p: string): T | null => {
  try {
    return readJson<T>(p);
  } catch {
    return null;
  }
};
/** Atomic (a crash or a second command never leaves half a file); refused outside temp during the self-test. */
export const writeJson = (p: string, value: unknown): void => writeJsonAtomic(p, value);
export const realPath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
