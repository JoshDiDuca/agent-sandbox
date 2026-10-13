import { spawn, spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';

export const isWin = process.platform === 'win32';
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * PowerShell arguments for a script passed encoded (no quoting issues, no progress-bar noise on stderr). Output is
 * UTF-8: Windows PowerShell 5.1 otherwise writes redirected stdout in the OEM code page, mangling non-ASCII (regional
 * date formats, wallpaper paths). UTF8Encoding($false): no byte-order mark in front of the output.
 */
const powerShellArgs = (script: string): string[] => {
  const prelude =
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n$ProgressPreference = 'SilentlyContinue'\n";
  const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
  // -OutputFormat Text: with redirected output PowerShell would otherwise print its progress stream as "#< CLIXML" XML.
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-OutputFormat',
    'Text',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded,
  ];
};

/** Runs a PowerShell script and returns its exit code (and stdout when `capture`). */
export const runPowerShell = (script: string, capture = false): { status: number; stdout: string } => {
  const result = spawnSync(SYSTEM.powershell(), powerShellArgs(script), {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};

/** Runs a program (an absolute path: `SYSTEM.*`, never a bare name) and returns its stdout, or '' if it failed or timed out. */
export const captureOutput = (
  file: string,
  args: string[],
  options: { timeout?: number; cwd?: string; maxBuffer?: number } = {},
): string => {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, ...options });
  return result.status === 0 ? (result.stdout ?? '') : '';
};

/** Async variant (does not block the event loop), resolving with stdout. */
export const runPowerShellAsync = (script: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(SYSTEM.powershell(), powerShellArgs(script), {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
