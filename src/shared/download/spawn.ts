import { spawn } from 'node:child_process';

/** Runs a program without blocking the event loop (parallel downloads keep going); resolves with its exit code. */
export const spawnAsync = (
  file: string,
  args: string[],
  options: import('node:child_process').SpawnOptions = {},
): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });
