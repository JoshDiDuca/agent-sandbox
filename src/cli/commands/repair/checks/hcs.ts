// The HCS engine (alpha), only when sandbox.engine is "hcs": can this PC run it. Looks only; the fixes are commands for
// you to run (they change Windows), never run by repair.
import { checkHcs, realHcsProbes, type HcsProbes } from '../../../../host/engines/index.js';
import type { Check, Finding, RepairEnv } from '../types.js';
import { ok } from './common.js';

const hcsInUse = (env: RepairEnv): boolean => env.ctx.loaded.config.sandbox.engine === 'hcs';

/** Replaceable by tests: the probes the row looks through. */
export const HCS_PROBES: { current: HcsProbes | null } = { current: null };

export const HCS_CHECKS: Check[] = [
  {
    id: 'hcs-engine',
    group: 'Sandbox',
    name: 'HCS engine (alpha)',
    checking: 'the HCS engine',
    applies: hcsInUse,
    timeoutMs: 60000,
    run: (): Finding => {
      const check = checkHcs(HCS_PROBES.current ?? realHcsProbes());
      if (check.available) return ok('this PC can run it (starting it is not enabled yet in this alpha)');
      return {
        status: 'needs-you',
        detail: check.reasons.length + ' thing(s) missing: ' + check.reasons[0],
        means: check.reasons.join(' '),
        fix: check.fixes.join('  |  '),
      };
    },
  },
];
