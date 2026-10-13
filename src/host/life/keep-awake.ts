import { spawn, type ChildProcess } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { isWin } from '../../core/util/index.js';
import { refuseInSelfTest } from '../test-guard.js';

/**
 * sandbox.keepAwake: asks Windows not to sleep while the sandbox runs (as a video player does; the screen may still
 * turn off). A small PowerShell holds the request until `ownerPid` exits, so it never outlives the watcher.
 */
export class KeepAwake {
  private constructor(private readonly child: ChildProcess) {}

  static start(ownerPid: number): KeepAwake | null {
    if (!isWin) return null;
    refuseInSelfTest('keep this PC awake');
    const script =
      'Add-Type -Name Power -Namespace AgentSandbox -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);\'; ' +
      '[void][AgentSandbox.Power]::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id ' +
      Math.trunc(ownerPid) +
      ' -ErrorAction SilentlyContinue';
    const child = spawn(
      SYSTEM.powershell(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('error', () => undefined);
    return new KeepAwake(child);
  }

  stop(): void {
    this.child.kill();
  }
}
