// Minimal test harness: PASS/FAIL lines, a temp folder that is always removed, small helpers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, errMsg, sleep } from '../core/util.js';

export interface Harness {
  packageRoot: string;
  temp: string;
  check: (ok: boolean, name: string) => void;
  rejects: (fn: () => unknown, needle: string) => Promise<boolean>;
  write: (file: string, content: string) => string;
  /** Polls `read` until it returns something truthy (or the timeout passes). */
  waitFor: <T>(read: () => T | null | undefined | false, ms?: number) => Promise<T | null>;
  section: (title: string) => void;
}

export const createHarness = (packageRoot: string): Harness & { failures: () => number; dispose: () => void } => {
  let failures = 0;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sandbox-test-'));
  return {
    packageRoot,
    temp,
    failures: () => failures,
    check: (ok, name) => { console.log((ok ? '\x1b[32mPASS\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m  ') + name); if (!ok) failures++; },
    rejects: async (fn, needle) => { try { await fn(); return false; } catch (e) { return errMsg(e).includes(needle); } },
    write: (file, content) => { ensureDir(path.dirname(file)); fs.writeFileSync(file, content); return file; },
    waitFor: async (read, ms = 30000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const v = read(); if (v) return v; await sleep(250); }
      return null;
    },
    section: (title) => console.log('\n\x1b[36m-- ' + title + '\x1b[0m'),
    dispose: () => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }),
  };
};
