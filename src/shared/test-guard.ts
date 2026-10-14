// Defence in depth for the self-test: while AGENT_SANDBOX_SELFTEST=1 is set, nothing may act on the real PC. Every
// write or delete on the host is limited to the temp folder the tests use (outward actions refuse in
// host/test-guard.ts). The self-test sets the variable for itself and its child processes. No imports from core/: the
// sandbox bundles this file too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function selfTestRunning(): boolean {
  return process.env.AGENT_SANDBOX_SELFTEST === '1';
}

/**
 * Resolves links in the part of the path that exists, so C:\Users\WDAGUT~1 and C:\Users\WDAGUtilityAccount compare
 * equal.
 */
const canonical = (p: string): string => {
  let rest = '';
  let current = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), rest).toLowerCase();
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p).toLowerCase();
      rest = path.join(path.basename(current), rest);
      current = parent;
    }
  }
};

/** Why the self-test may not write, copy or delete at `target` (anywhere but the temp folder), or null. */
export function testWriteRefusal(target: string): string | null {
  if (!selfTestRunning()) return null;
  const temp = canonical(os.tmpdir());
  const t = canonical(target);
  return t === temp || t.startsWith(temp + path.sep)
    ? null
    : 'The self-test refused to change ' + target + ': it only works in temp folders, so it can never change this PC.';
}

export function assertTestWritable(target: string): void {
  const refusal = testWriteRefusal(target);
  if (refusal) throw new Error(refusal);
}
