// This PC: Windows itself, what Windows Sandbox needs of it, and whether Windows wants a restart. The hardware and
// edition answers come from the same look `sandbox setup` takes (once per run).
import { isWin } from '../../../../core/util/index.js';
import { updateRestartPending } from '../../../../host/life/index.js';
import { buildChecks, type CheckStatus } from '../../setup/checks.js';
import type { Check, Finding, RepairEnv } from '../types.js';
import { ok } from './common.js';

const STATUS: Record<CheckStatus, Finding['status']> = { ok: 'ok', warn: 'warn', action: 'needs-you' };

/** One line of the setup checklist as a check. */
export function fromFacts(id: string, group: Check['group'], setupName: string, name: string = setupName): Check {
  return {
    id,
    group,
    name,
    timeoutMs: 60_000,
    run: (env: RepairEnv): Finding => {
      const row = buildChecks(env.facts()).find((c) => c.name === setupName);
      if (!row) return { status: 'skipped', detail: 'no answer for "' + setupName + '"' };
      return { status: STATUS[row.status], detail: row.detail };
    },
  };
}

export const PC_CHECKS: Check[] = [
  {
    id: 'pc-windows',
    group: 'This PC',
    name: 'Windows',
    run: (): Finding =>
      isWin
        ? ok('Windows ' + process.arch)
        : {
            status: 'needs-you',
            detail: 'this is not Windows',
            means: 'Windows Sandbox only runs on Windows.',
            fix: 'Run sandbox on a Windows 10/11 Pro, Enterprise or Education PC.',
          },
  },
  fromFacts('pc-edition', 'This PC', 'Windows edition', 'Windows edition'),
  fromFacts('pc-virtualization', 'This PC', 'CPU virtualization', 'CPU virtualization'),
  fromFacts('pc-memory', 'This PC', 'Memory', 'Memory'),
  fromFacts('pc-node', 'This PC', 'Node.js', 'Node.js'),
  {
    id: 'pc-restart-pending',
    group: 'This PC',
    name: 'Windows restart',
    timeoutMs: 40_000,
    run: (): Finding =>
      updateRestartPending()
        ? {
            status: 'warn',
            detail: 'Windows is waiting for a restart',
            means: 'Windows may restart on its own and close a running sandbox.',
            fix: 'Restart Windows when it suits you, or pause Windows updates while you work.',
          }
        : ok('no restart pending'),
  },
];
