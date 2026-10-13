// What a test file exports: a named group of checks that index.ts runs in order.
import type { Fixtures } from './fixtures.js';
import type { Harness } from './harness.js';

export interface Suite {
  /** Short name used to run just this suite: `sandbox self-test <name>`. */
  name: string;
  /** One line: what area this suite covers (shown by `self-test --list` style output and in failures). */
  title: string;
  run: (t: Harness, f: Fixtures) => void | Promise<void>;
  /** Starts real processes (the daemon, ptyhost, csc, git): skipped where Windows cannot run them. */
  live?: boolean;
  /** A suite that takes longer than this is reported as a failure and the run continues. Default 2 minutes. */
  timeoutMs?: number;
}
