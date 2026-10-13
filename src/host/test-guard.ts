// Host side of the self-test guard (see shared/test-guard.ts): outward actions refuse, with a message the user can read.
import { testWriteRefusal, selfTestRunning } from '../shared/test-guard.js';
import { fail } from '../core/util/index.js';

export { selfTestRunning };

/** Refuses an action that reaches outside the test's own temp folder (a no-op outside the self-test). */
export const refuseInSelfTest = (what: string): void => {
  if (selfTestRunning())
    fail('The self-test does not ' + what + '.', 'It only works in temp folders, so it can never change this PC.');
};

/** A write, copy or delete on the host: during the self-test only the temp folder is allowed. */
export const assertTestWritable = (target: string): void => {
  const refusal = testWriteRefusal(target);
  if (refusal) fail(refusal);
};
