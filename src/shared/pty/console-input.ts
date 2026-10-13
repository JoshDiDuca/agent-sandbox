// Windows: lets the terminal's own input sequences (mouse clicks and wheel, focus) reach a Node process in raw mode.
// Node reads the console as key records in raw mode and drops every mouse record, so an agent that turned mouse
// tracking on (its terminal then sends the wheel and clicks as mouse reports) got neither. With
// ENABLE_VIRTUAL_TERMINAL_INPUT the console hands over the terminal's input as it is: mouse reports, focus, keys.
// Node has no API for the console mode, so sandbox\scripts\enable-vt-input.ps1 sets it on the console both share (the input mode
// belongs to the console, not to a handle). PowerShell starts in a console of its own, hidden (so it never retitles
// your tab or touches its modes), then switches to ours. Only built-ins here: view.js bundles this.
import { spawn, type ChildProcess } from 'node:child_process';
import { SYSTEM } from '../system.js';
import { scriptArgs } from '../scripts.js';

export interface VtInput {
  /** true once the console passes the terminal's input through (mouse reports included); false if it could not. */
  ready: Promise<boolean>;
  /** Stops a change still in progress; resolves when nothing can change the console mode any more. */
  stop: () => Promise<void>;
}

/**
 * Turns on ENABLE_VIRTUAL_TERMINAL_INPUT for this process's console. Call it after stdin.setRawMode(true) (which
 * overwrites the mode); setRawMode(false) turns it off again. No-op off Windows or without a console.
 */
export function enableVtInput(): VtInput {
  if (process.platform !== 'win32' || !process.stdin.isTTY)
    return { ready: Promise.resolve(false), stop: () => Promise.resolve() };
  let child: ChildProcess | null = null;
  let exited: Promise<void> = Promise.resolve();
  const ready = new Promise<boolean>((resolve) => {
    try {
      child = spawn(SYSTEM.powershell(), scriptArgs('enable-vt-input.ps1', ['-ProcessId', String(process.pid)]), {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    exited = new Promise<void>((done) => {
      child?.on('exit', (code) => {
        resolve(code === 0);
        done();
      });
      child?.on('error', () => {
        resolve(false);
        done();
      });
    });
  });
  return {
    ready,
    stop: () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      return exited;
    },
  };
}
