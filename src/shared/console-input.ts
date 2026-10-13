// Windows: lets the terminal's own input sequences (mouse clicks and wheel, focus) reach a Node process in raw mode.
// Node reads the console as key records in raw mode and drops every mouse record, so an agent that turned mouse
// tracking on (its terminal then sends the wheel and clicks as mouse reports) got neither. With
// ENABLE_VIRTUAL_TERMINAL_INPUT the console hands over the terminal's input as it is: mouse reports, focus, keys.
// Node has no API for the console mode, so a PowerShell child sets it on the console both share (the input mode
// belongs to the console, not to a handle). Only built-ins here: view.js bundles this.
import { spawn, type ChildProcess } from 'node:child_process';
import { SYSTEM } from './system.js';

/**
 * PowerShell starts in a console of its own, hidden (so it never retitles your tab or touches its modes), then switches
 * to ours. Started without any console, powershell.exe does nothing at all.
 */
const script = (pid: number): string => [
  'Add-Type -TypeDefinition @"',
  'using System; using System.Runtime.InteropServices;',
  'public static class SbxVtInput {',
  '  [DllImport("kernel32.dll")] static extern bool FreeConsole();',
  '  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);',
  '  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);',
  '  [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr handle, uint mode);',
  '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);',
  '  public static int On(uint pid) {',
  '    FreeConsole();',
  '    if (!AttachConsole(pid)) return 2;',
  '    IntPtr input = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);',
  '    if (input == new IntPtr(-1)) return 3;',
  '    uint mode; bool ok = GetConsoleMode(input, out mode) && SetConsoleMode(input, mode | 0x200);',
  '    CloseHandle(input);',
  '    FreeConsole();',
  '    return ok ? 0 : 4;',
  '  }',
  '}',
  '"@',
  'exit [SbxVtInput]::On(' + pid + ')',
].join('\n');

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
export const enableVtInput = (): VtInput => {
  if (process.platform !== 'win32' || !process.stdin.isTTY) return { ready: Promise.resolve(false), stop: () => Promise.resolve() };
  let child: ChildProcess | null = null;
  let exited: Promise<void> = Promise.resolve();
  const ready = new Promise<boolean>((resolve) => {
    try {
      child = spawn(SYSTEM.powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script(process.pid), 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
    } catch { resolve(false); return; }
    exited = new Promise<void>((done) => {
      child?.on('exit', (code) => { resolve(code === 0); done(); });
      child?.on('error', () => { resolve(false); done(); });
    });
  });
  return { ready, stop: () => { if (child && child.exitCode === null && child.signalCode === null) child.kill(); return exited; } };
};
