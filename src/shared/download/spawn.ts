import { spawn, type SpawnOptions } from 'node:child_process';

/** Runs a program without blocking the event loop (parallel downloads keep going); resolves with its exit code. */
export function spawnAsync(file: string, args: string[], options: SpawnOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });
}
