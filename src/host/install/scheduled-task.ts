// The scheduled task that installs updates for an all-users install: \WindowsDevelopmentSandbox\Update, daily at 03:00
// as SYSTEM. Created and removed by native\scripts\set-update-task.ps1 (needs an admin PowerShell).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fail } from '../../core/util/index.js';
import { SYSTEM } from '../../shared/system.js';
import { nativeScript } from '../native.js';
import { refuseInSelfTest } from '../test-guard.js';
import type { InstallLayout } from './layout.js';

/** The script's exit code when the PowerShell is not elevated. */
const NOT_ADMIN = 2;

export class UpdateTask {
  constructor(private readonly layout: InstallLayout) {}

  /** The arguments of the script that sets the task up for this install (the shim is what the task runs). */
  static registerArgs(layout: InstallLayout): string[] {
    return ['-Command', path.join(layout.binDir, 'sandbox.cmd')];
  }

  register(): void {
    this.run(UpdateTask.registerArgs(this.layout), 'set up automatic updates');
  }

  remove(): void {
    this.run(['-Remove'], 'remove automatic updates');
  }

  private run(args: string[], what: string): void {
    refuseInSelfTest(what);
    const run = spawnSync(SYSTEM.powershell(), nativeScript('set-update-task.ps1', args), {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    });
    if (run.status === 0) return;
    if (run.status === NOT_ADMIN)
      fail(
        'Could not ' + what + ': it needs admin rights.',
        'Run this in an admin PowerShell (right-click Start > Terminal (Admin)).',
      );
    const reason = (run.stderr || run.stdout || run.error?.message || 'no output').trim();
    fail('Could not ' + what + ': ' + reason);
  }
}
