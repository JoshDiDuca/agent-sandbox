// `sandbox setup`: checks this PC can run Windows Sandbox and offers to turn the feature on.
import { spawnSync } from 'node:child_process';
import { askYesNo } from '../../../core/prompt.js';
import { fail, isWin } from '../../../core/util/index.js';
import { insideSandbox, sandboxFeatureInstalled } from '../../../host/sandbox/index.js';
import { refuseInSelfTest } from '../../../host/test-guard.js';
import { SYSTEM } from '../../../shared/system.js';
import { c, table } from '../../output/index.js';
import { HealthService } from '../../services/index.js';
import { type Context } from '../context.js';
import { type Check, type CheckStatus } from './checks.js';
import { ENABLE_COMMAND } from './facts.js';

const LABEL: Record<CheckStatus, string> = {
  ok: c.green('OK'),
  warn: c.yellow('WARNING'),
  action: c.red('ACTION NEEDED'),
};
function print(checks: Check[]): void {
  table(checks.map((check) => [LABEL[check.status], check.name, check.detail]));
}

/** Seconds Windows waits before it restarts (shutdown /a cancels in that time). */
const RESTART_DELAY_SECONDS = 30;

/** After turning the feature on Windows must restart: offered, never done without a yes. */
async function offerRestart(): Promise<void> {
  if (!(await askYesNo('Restart Windows now?'))) return;
  refuseInSelfTest('restart Windows');
  spawnSync(SYSTEM.shutdown(), ['/r', '/t', String(RESTART_DELAY_SECONDS)], { windowsHide: true });
  console.log('Windows restarts in ' + RESTART_DELAY_SECONDS + ' seconds. To cancel: shutdown /a');
}

/**
 * First start on a PC without Windows Sandbox: offers to turn it on (the setup steps) instead of a bare error.
 * Returns the setup's exit code, or undefined when there is nothing to offer (it is on, no terminal, or declined).
 */
export async function offerSetupWhenOff(ctx: Context): Promise<number | undefined> {
  if (!isWin || insideSandbox() || sandboxFeatureInstalled() || !process.stdin.isTTY) return undefined;
  return (await askYesNo('Windows Sandbox is not turned on. Turn it on now?', true)) ? setup(ctx) : undefined;
}

export async function setup(ctx: Context): Promise<number> {
  const health = new HealthService(ctx);
  health.assertWindows();
  console.log('Checking this PC for Windows Sandbox...\n');
  const first = health.setupReport();
  let checks = first.checks;
  print(checks);
  if (first.canEnable) {
    console.log('');
    if (await askYesNo('Turn on Windows Sandbox now? Windows will ask for admin permission.')) {
      console.log('Enabling Windows Sandbox (this can take a minute)...');
      if (!health.enableFeature())
        fail(
          'Windows Sandbox could not be enabled (or the admin prompt was declined).',
          'In an admin PowerShell run: ' + ENABLE_COMMAND + ', then restart Windows.',
        );
      console.log('Done. Restart Windows to finish, then run sandbox setup again.\n');
      checks = health.setupReport().checks;
      print(checks);
      await offerRestart();
    } else
      console.log('To do it yourself, in an admin PowerShell run:\n  ' + ENABLE_COMMAND + '\nthen restart Windows.');
  }
  const todo = checks.filter((check) => check.status === 'action').length;
  console.log(
    '\n' +
      (todo
        ? todo + ' thing(s) to fix before the sandbox can start (see ACTION NEEDED above).'
        : 'This PC is ready. cd into a project and run sandbox claude (or sandbox for no agent).'),
  );
  return todo ? 1 : 0;
}
