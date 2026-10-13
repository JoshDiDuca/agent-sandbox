import fs from 'node:fs';
import type { z } from 'zod';

/** Small JSON state files in tools\: read with zod (a half-written file is just empty), written atomically. */
export function readState<S extends z.ZodType>(file: string, schema: S, empty: z.output<S>): z.output<S> {
  try {
    return schema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))).data ?? empty;
  } catch {
    return empty;
  }
}
