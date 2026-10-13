import { spawn, type ChildProcess } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { isWin } from '../../core/util/index.js';
import { refuseInSelfTest } from '../test-guard.js';
import { hostToolsExe, nativeScript } from '../native.js';

/**
 * sandbox.keepAwake: asks Windows not to sleep while the sandbox runs (as a video player does; the screen may still
 * turn off). A helper process holds the request until `ownerPid` exits, so it never outlives the watcher.
 */
export class KeepAwake {
  private constructor(private readonly child: ChildProcess) {}

  /** HostTools.exe keep-awake (built in <storageRoot>\bin), else native\scripts\keep-awake.ps1. */
  static start(ownerPid: number, storageRoot: string): KeepAwake | null {
    if (!isWin) return null;
    refuseInSelfTest('keep this PC awake');
    const pid = String(Math.trunc(ownerPid));
    const tools = hostToolsExe(storageRoot);
    const options = { stdio: 'ignore' as const, windowsHide: true };
    const child = tools
      ? spawn(tools, ['keep-awake', '--owner-pid', pid], options)
      : spawn(SYSTEM.powershell(), nativeScript('keep-awake.ps1', ['-OwnerId', pid]), options);
    child.on('error', () => undefined);
    return new KeepAwake(child);
  }

  stop(): void {
    this.child.kill();
  }
}
