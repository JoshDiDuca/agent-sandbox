// Minimal test harness: PASS/FAIL lines (a failure shows what was expected and what was found), assertion helpers,
// and a temp folder that is always removed. Every test writes only below `t.temp`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect, isDeepStrictEqual } from 'node:util';
import { ensureDir, errMsg, sleep } from '../core/util.js';

/** Text a failure message must contain (string) or match (RegExp). */
export type Expected = string | RegExp;

export interface Harness {
  packageRoot: string;
  /** The folder every test works in; removed at the end. */
  temp: string;
  section: (title: string) => void;
  /** Prints a SKIP line (not a check). */
  skip: (what: string) => void;

  /** The basic assertion. `detail` is printed under a failing check, so say what was found. */
  check: (ok: boolean, name: string, detail?: string) => void;
  /** Deep equality; on failure both values are shown. */
  equal: <T>(actual: T, expected: T, name: string) => void;
  /** `text` contains `needle`; on failure the text is shown. */
  includes: (text: string, needle: string, name: string) => void;
  /** `text` does not contain `needle`. */
  excludes: (text: string, needle: string, name: string) => void;
  /** `text` matches the pattern. */
  matches: (text: string, pattern: RegExp, name: string) => void;
  /** `fn` (sync or async) throws an error whose message (or `fix` hint) contains/matches `expected`. */
  throws: (fn: () => unknown, expected: Expected, name: string) => Promise<void>;
  /** Runs `fn` and returns the message of the error it throws ('' when it does not throw). */
  thrownMessage: (fn: () => unknown) => Promise<string>;

  /** Path below the temp folder (nothing is created). */
  at: (...parts: string[]) => string;
  /** Creates (if needed) and returns a folder below the temp folder. */
  dir: (...parts: string[]) => string;
  /** Writes a text file below anywhere in the temp folder (parents are created) and returns its path. */
  write: (file: string, content: string) => string;
  /** Writes `value` as JSON and returns the path. */
  writeJson: (file: string, value: unknown) => string;
  readJson: <T = any>(file: string) => T;

  /**
   * Polls `read` every `everyMs` until it returns something truthy and returns that, or returns null after `ms`.
   * Use this instead of fixed sleeps: it is fast when the machine is idle and patient when it is busy.
   */
  waitFor: <T>(read: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms?: number, everyMs?: number) => Promise<T | null>;
}

export interface RunningHarness extends Harness {
  /** Number of checks that failed so far. */
  failures: () => number;
  /** Number of checks that ran so far (passed or failed). */
  checks: () => number;
  dispose: () => void;
}

const show = (value: unknown): string => inspect(value, { depth: 6, breakLength: 110, maxStringLength: 600, maxArrayLength: 40 });
const indent = (text: string): string => text.split('\n').map((line) => '        ' + line).join('\n');
const clip = (text: string, max = 800): string => (text.length > max ? text.slice(0, max) + ' ... (' + text.length + ' characters)' : text);

export const createHarness = (packageRoot: string): RunningHarness => {
  let failed = 0;
  let total = 0;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sandbox-test-'));

  const check: Harness['check'] = (ok, name, detail) => {
    total++;
    console.log((ok ? '\x1b[32mPASS\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m  ') + name);
    if (ok) return;
    failed++;
    if (detail) console.log(indent(detail));
  };

  /** Runs `fn` once; the message includes the `fix` hint of a UserError. */
  const attempt = async (fn: () => unknown): Promise<{ threw: false } | { threw: true; message: string }> => {
    try { await fn(); return { threw: false }; } catch (e) { return { threw: true, message: (errMsg(e) + ' ' + ((e as { fix?: string }).fix ?? '')).trim() }; }
  };
  const thrownMessage: Harness['thrownMessage'] = async (fn) => {
    const outcome = await attempt(fn);
    return outcome.threw ? outcome.message : '';
  };

  const write: Harness['write'] = (file, content) => { ensureDir(path.dirname(file)); fs.writeFileSync(file, content); return file; };

  return {
    packageRoot,
    temp,
    failures: () => failed,
    checks: () => total,
    check,
    equal: (actual, expected, name) => check(isDeepStrictEqual(actual, expected), name, 'expected: ' + show(expected) + '\nactual:   ' + show(actual)),
    includes: (text, needle, name) => check(text.includes(needle), name, 'expected to contain: ' + show(needle) + '\nactual: ' + show(clip(text))),
    excludes: (text, needle, name) => check(!text.includes(needle), name, 'expected NOT to contain: ' + show(needle) + '\nactual: ' + show(clip(text))),
    matches: (text, pattern, name) => check(pattern.test(text), name, 'expected to match: ' + String(pattern) + '\nactual: ' + show(clip(text))),
    throws: async (fn, expected, name) => {
      const outcome = await attempt(fn);
      const message = outcome.threw ? outcome.message : '';
      const ok = outcome.threw && (typeof expected === 'string' ? message.includes(expected) : expected.test(message));
      check(ok, name, 'expected an error containing: ' + String(expected) + '\n' + (outcome.threw ? 'actual error: ' + show(clip(message)) : 'but nothing was thrown'));
    },
    thrownMessage,
    section: (title) => console.log('\n\x1b[36m-- ' + title + '\x1b[0m'),
    skip: (what) => console.log('SKIP  ' + what),
    at: (...parts) => path.join(temp, ...parts),
    dir: (...parts) => { const p = path.join(temp, ...parts); ensureDir(p); return p; },
    write,
    writeJson: (file, value) => write(file, JSON.stringify(value)),
    readJson: (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
    waitFor: async (read, ms = 30000, everyMs = 100) => {
      const end = Date.now() + ms;
      for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() >= end) return null;
        await sleep(everyMs);
      }
    },
    dispose: () => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }),
  };
};
