import os from 'node:os';
import path from 'node:path';
import { fileExists } from './fs.js';

export function homeDir(): string {
  return process.env.USERPROFILE ?? os.homedir();
}

/** Expands %VAR% and resolves relative paths against `base`. */
export function expandPath(input: string, base: string): string {
  const expanded = input
    .replace(/%([^%]+)%/g, (_m: string, name: string) => process.env[name] ?? '%' + name + '%')
    .replace(/^~(?=$|[\\/])/, homeDir());
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(base, expanded));
}
export function isRootPath(p: string): boolean {
  const n = path.resolve(p);
  return n.toLowerCase() === path.parse(n).root.toLowerCase();
}
export function isUserProfile(p: string): boolean {
  const profile = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return profile !== '' && path.resolve(p).toLowerCase() === path.resolve(profile).toLowerCase();
}
export function isInsideOrEqual(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function findOnPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter((d: string) => d !== '');
  for (const name of names)
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) return candidate;
    }
  return null;
}
