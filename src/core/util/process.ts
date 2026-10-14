import { spawnSync } from 'node:child_process';

export const isWin = process.platform === 'win32';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a program (an absolute path: `SYSTEM.*`, never a bare name) and returns its stdout, or '' if it failed or timed
 * out.
 */
export function captureOutput(
  file: string,
  args: string[],
  options: { timeout?: number; cwd?: string; maxBuffer?: number } = {},
): string {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, ...options });
  return result.status === 0 ? (result.stdout ?? '') : '';
}
