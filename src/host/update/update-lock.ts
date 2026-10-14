// <root>\update.lock: only one update runs at a time (the scheduled task, a command in a terminal, and the background
// start of a CLI can overlap). A lock left by a process that died, or older than a few hours, is taken over.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';

const LockSchema = z.object({ pid: z.number().int(), at: z.string() });
const STALE_MS = 3 * 60 * 60 * 1000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but is someone else's.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export class UpdateLock {
  private readonly store: JsonFile<z.infer<typeof LockSchema>>;

  constructor(
    root: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.store = new JsonFile(LockSchema, path.join(root, 'update.lock'));
  }

  /** Takes the lock; null when another update holds it. Call the returned function to let go. */
  acquire(): (() => void) | null {
    const held = this.store.read();
    if (held && alive(held.pid) && this.now().getTime() - Date.parse(held.at) < STALE_MS) return null;
    fs.rmSync(this.store.file, { force: true });
    try {
      // Created only if it does not exist: of two processes that get here together, one wins.
      const mine: z.infer<typeof LockSchema> = { pid: process.pid, at: this.now().toISOString() };
      fs.writeFileSync(this.store.file, JSON.stringify(mine) + '\n', { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw e;
    }
    return () => {
      const current = this.store.read();
      if (current?.pid === process.pid) fs.rmSync(this.store.file, { force: true });
    };
  }
}
