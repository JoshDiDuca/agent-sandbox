// Where the portable MSVC lives (tools\msvc) and what the last finished install recorded about it.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exists } from '../../../runtime/fs.js';
import { tool } from '../../tool-env.js';

export const ROOT = tool('msvc');
export const MARKER = path.join(ROOT, '.installed.json');

export function msvcTools(msvc: string, ...parts: string[]): string {
  return path.join(ROOT, 'VC', 'Tools', 'MSVC', msvc, ...parts);
}
export function hostBin(msvc: string, ...parts: string[]): string {
  return msvcTools(msvc, 'bin', 'Hostx64', 'x64', ...parts);
}
export function hasCompiler(msvc: string): boolean {
  return exists(hostBin(msvc, 'cl.exe'));
}

const InstalledSchema = z.object({ msvc: z.string().min(1), sdk: z.string().min(1), want: z.string() });
export type Installed = z.infer<typeof InstalledSchema>;

/** What the last finished install recorded; null for a missing, unreadable or half-written marker. */
export function readInstalled(): Installed | null {
  try {
    return InstalledSchema.safeParse(JSON.parse(fs.readFileSync(MARKER, 'utf8'))).data ?? null;
  } catch {
    return null;
  }
}
