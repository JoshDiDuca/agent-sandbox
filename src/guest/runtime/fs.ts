import fs from 'node:fs';

export function exists(p: string): boolean {
  return fs.existsSync(p);
}
export function mkdirp(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
