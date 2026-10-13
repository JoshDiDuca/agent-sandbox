// Where the portable MSVC lives (tools\msvc) and what the last finished install recorded about it.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exists } from '../../../env.js';
import { tool } from '../../common.js';

export const ROOT = tool('msvc');
export const MARKER = path.join(ROOT, '.installed.json');

export const msvcTools = (msvc: string, ...parts: string[]): string =>
  path.join(ROOT, 'VC', 'Tools', 'MSVC', msvc, ...parts);
export const hostBin = (msvc: string, ...parts: string[]): string => msvcTools(msvc, 'bin', 'Hostx64', 'x64', ...parts);
export const hasCompiler = (msvc: string): boolean => exists(hostBin(msvc, 'cl.exe'));

const Installed = z.object({ msvc: z.string().min(1), sdk: z.string().min(1), want: z.string() });
export type Installed = z.infer<typeof Installed>;

/** What the last finished install recorded; null for a missing, unreadable or half-written marker. */
export const readInstalled = (): Installed | null => {
  try {
    return Installed.safeParse(JSON.parse(fs.readFileSync(MARKER, 'utf8'))).data ?? null;
  } catch {
    return null;
  }
};
