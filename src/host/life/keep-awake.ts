import { spawn, type ChildProcess } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { isWin } from '../../core/util/index.js';
import { refuseInSelfTest } from '../test-guard.js';
import { nativeScript } from '../native.js';

/**
 * sandbox.keepAwake: asks Windows not to sleep while the sandbox runs (as a video player does; the screen may still
 * turn off). native\scripts\keep-awake.ps1 holds the request until `ownerPid` exits, so it never outlives the watcher.
 */
export class KeepAwake {
  private constructor(private readonly child: ChildProcess) {}

  static start(ownerPid: number): KeepAwake | null {
    if (!isWin) return null;
    refuseInSelfTest('keep this PC awake');
    const child = spawn(
      SYSTEM.powershell(),
      nativeScript('keep-awake.ps1', ['-OwnerId', String(Math.trunc(ownerPid))]),
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.on('error', () => undefined);
    return new KeepAwake(child);
  }

  stop(): void {
    this.child.kill();
  }
}
