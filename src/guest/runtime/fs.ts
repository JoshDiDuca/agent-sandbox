import fs from 'node:fs';

export const exists = (p: string): boolean => fs.existsSync(p);
export const mkdirp = (p: string): string => {
  fs.mkdirSync(p, { recursive: true });
  return p;
};
