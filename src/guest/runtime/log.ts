import fs from 'node:fs';
import path from 'node:path';
import { logsDir } from './paths.js';

fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(
  logsDir,
  (process.env.AGENT_LOG_PREFIX ?? 'guest') + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log',
);
const append = (line: string): void => {
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    /* logging must never break the run */
  }
};

export function log(message: string): void {
  console.log(message);
  append(message);
}
export function warn(message: string): void {
  console.warn('\x1b[33mWARNING: ' + message + '\x1b[0m');
  append('WARNING: ' + message);
}
export const logPath = logFile;
