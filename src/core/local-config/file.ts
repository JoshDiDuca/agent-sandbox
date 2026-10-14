import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LocalConfigFile } from '../types.js';
import { fileExists, parseJsonc } from '../util/index.js';

export const LOCAL_CONFIG_NAME = '.sandbox-config.json';

export function readLocalConfig(dir: string): LocalConfigFile | null {
  const file = path.join(dir, LOCAL_CONFIG_NAME);
  if (!fileExists(file)) return null;
  const raw = fs.readFileSync(file);
  return {
    path: file,
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
    data: parseJsonc<unknown>(raw.toString('utf8'), file),
  };
}
