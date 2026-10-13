import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';

/** [host size, host time, view size, view time] after the last sync; -1 = no such file. */
export type Seen = [number, number, number, number];
export const Manifest = z.record(z.string().max(1024), z.tuple([z.number(), z.number(), z.number(), z.number()]));

/** Most entries one walk looks at: a sandbox can create files faster than they are worth syncing. */
export const MAX_ENTRIES = 300000;

export const stamp = (file: string): [number, number] => {
  try {
    const s = fs.lstatSync(file);
    return s.isFile() ? [s.size, Math.round(s.mtimeMs)] : [-1, -1];
  } catch {
    return [-1, -1];
  }
};

export const sameContent = (a: string, b: string): boolean => {
  const hash = (f: string): string => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  try {
    return fs.statSync(a).size === fs.statSync(b).size && hash(a) === hash(b);
  } catch {
    return false;
  }
};

/** A path from an event or the manifest: relative, forward slashes, no way out of the root. */
export const safeRel = (rel: string): string | null => {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.length > 1000 || clean.split('/').some((p) => p === '..' || p === '' || p.includes(':')))
    return null;
  return clean;
};
