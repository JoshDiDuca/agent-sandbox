// `sandbox setup`: checks this PC can run Windows Sandbox and offers to turn the feature on.
import { spawnSync } from 'node:child_process';
import { askYesNo } from '../../../core/prompt.js';
import { fail, isWin } from '../../../core/util/index.js';
import { refuseInSelfTest } from '../../../host/test-guard.js';
import { SYSTEM } from '../../../shared/system.js';
import { c, table } from '../../output/index.js';
import { type Context } from '../context.js';
import { buildChecks, canEnableFeature, type Check, type CheckStatus } from './checks.js';
import { ENABLE_COMMAND, gatherFacts } from './facts.js';

const LABEL: Record<CheckStatus, string> = {
  ok: c.green('OK'),
  warn: c.yellow('WARNING'),
  action: c.red('ACTION NEEDED'),
};
function print(checks: Check[]): void {
  table(checks.map((check) => [LABEL[check.status], check.name, check.detail]));
}

/** Runs the enable command in an elevated PowerShell (Windows asks for permission); true if it worked. */
function enableFeature(): boolean {
  refuseInSelfTest('turn on Windows features');
  const inner = "'-NoProfile','-Command','" + ENABLE_COMMAND + " | Out-Null'";
  const outer =
    "try { $p = Start-Process -FilePath '" +
    SYSTEM.powershell() +
    "' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList " +
    inner +
    '; exit $p.ExitCode } catch { exit 1 }';
  return (
    spawnSync(SYSTEM.powershell(), ['-NoProfile', '-NonInteractive', '-Command', outer], { stdio: 'inherit' })
      .status === 0
  );
}

export async function setup(ctx: Context): Promise<number> {
  if (!isWin)
    fail(
      'Windows Sandbox only runs on Windows.',
      'Run sandbox setup on a Windows 10/11 Pro, Enterprise or Education PC.',
    );
  console.log('Checking this PC for Windows Sandbox...\n');
  const facts = gatherFacts(ctx.storageRoot);
  let checks = buildChecks(facts);
  print(checks);
  if (canEnableFeature(facts)) {
    console.log('');
    if (await askYesNo('Turn on Windows Sandbox now? Windows will ask for admin permission.')) {
      console.log('Enabling Windows Sandbox (this can take a minute)...');
      if (!enableFeature())
        fail(
          'Windows Sandbox could not be enabled (or the admin prompt was declined).',
          'In an admin PowerShell run: ' + ENABLE_COMMAND + ', then restart Windows.',
        );
      console.log('Done. Restart Windows to finish, then run sandbox setup again.\n');
      checks = buildChecks(gatherFacts(ctx.storageRoot));
      print(checks);
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
