// Opens an address in the default browser (through cmd's start; the address is one we built, hex and digits only).
import { spawn } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { refuseInSelfTest } from '../test-guard.js';

export function openBrowser(url: string): void {
  refuseInSelfTest('open a browser');
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/(#k=[0-9a-f]{64})?$/.test(url)) throw new Error('Not a web UI address.');
  spawn(SYSTEM.cmd(), ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
