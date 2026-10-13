// One persisted JSON file with its shape: read through zod (missing, oversized or malformed counts as absent), written
// atomically.
import type { z } from 'zod';
import { readValid, writeJsonAtomic } from './json.js';

export class JsonFile<T> {
  constructor(
    private readonly schema: z.ZodType<T>,
    readonly file: string,
  ) {}

  read(): T | null {
    return readValid(this.schema, this.file);
  }

  write(value: T): void {
    writeJsonAtomic(this.file, value);
  }

  /** Reads, changes and writes back; returns what was written. */
  update(change: (current: T | null) => T): T {
    const next = change(this.read());
    this.write(next);
    return next;
  }
}
