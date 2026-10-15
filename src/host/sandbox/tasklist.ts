// The process list (`tasklist /NH /FO CSV`) that "is the sandbox running?" and "whose is it?" come from. Commands
// ask it synchronously. The menu cannot wait for a child process on every key, so it keeps a copy fresh in the
// background (readTasklistAsync) and installs it with useTasklistCache: until then, and after it is removed, every
// question runs tasklist itself.
import { spawn, spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';

/** The longest tasklist may take before it counts as stuck. */
const TASKLIST_TIMEOUT_MS = 15000;
const ARGS = ['/NH', '/FO', 'CSV'];

/** Runs tasklist: the real one, or what a test put in its place. */
export interface TasklistRunners {
  sync(): string;
  async(): Promise<string>;
}

const REAL_RUNNERS: TasklistRunners = {
  sync: () =>
    spawnSync(SYSTEM.tasklist(), ARGS, { encoding: 'utf8', windowsHide: true, timeout: TASKLIST_TIMEOUT_MS }).stdout ??
    '',
  async: () =>
    new Promise<string>((resolve) => {
      let out = '';
      const child = spawn(SYSTEM.tasklist(), ARGS, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const timer = setTimeout(() => child.kill(), TASKLIST_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (out += chunk));
      // A tasklist that cannot start or is killed counts as an empty list, like the synchronous one.
      child.on('error', () => {
        clearTimeout(timer);
        resolve('');
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(out);
      });
    }),
};

let runners: TasklistRunners = REAL_RUNNERS;
let cache: (() => string | undefined) | null = null;

/** Replaces how tasklist runs (tests count the calls); no argument puts the real one back. */
export function useTasklistRunners(replacement: TasklistRunners = REAL_RUNNERS): void {
  runners = replacement;
}

/** While set, a synchronous read returns this copy (undefined: none yet, run tasklist). Null removes it. */
export function useTasklistCache(read: (() => string | undefined) | null): void {
  cache = read;
}

/** The process list now: the cached copy when the menu keeps one, else a run of tasklist the caller waits for. */
export function readTasklist(): string {
  return cache?.() ?? runners.sync();
}

/** The process list from a run of tasklist that does not block the program (the menu's background refresh). */
export function readTasklistAsync(): Promise<string> {
  return runners.async();
}
