import fs from 'node:fs';
import { writeJsonAtomic } from '../../shared/io/index.js';

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}
export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
/** fileExists without blocking the program (the menu looks for programs while it stays responsive). */
export async function fileExistsAsync(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}
export function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as T;
}
export function tryReadJson<T>(p: string): T | null {
  try {
    return readJson<T>(p);
  } catch {
    return null;
  }
}
/** Atomic (a crash or a second command never leaves half a file); refused outside temp during the self-test. */
export function writeJson(p: string, value: unknown): void {
  return writeJsonAtomic(p, value);
}
export function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
