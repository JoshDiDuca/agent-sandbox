// Why the last sandbox stopped, when nobody stopped it. The background watcher writes a host-only "life" record (when
// the sandbox started, when it was last seen running, how it ended) and keeps this PC awake while it runs
// (sandbox.keepAwake). When the PC restarts, sleeps or crashes, the watcher stops too and the record has no end: the
// next launch reads Windows' System log from that moment on and says what happened, and what keeps it from happening.
import path from 'node:path';
import { z } from 'zod';
import { readValid, writeJsonAtomic } from '../../shared/io/index.js';
import type { StopCause } from './stop-events.js';

export const Iso = z.string().max(40);
const Life = z.object({
  started: Iso,
  lastSeen: Iso,
  keepAwake: z.boolean(),
  ended: z
    .object({
      at: Iso,
      cause: z
        .object({
          kind: z.enum(['updates', 'restart', 'crash', 'sleep', 'memory', 'sandboxCrash']),
          at: Iso,
          text: z.string().max(400),
        })
        .nullable(),
    })
    .optional(),
  reported: z.boolean().optional(),
});
type LifeT = z.infer<typeof Life>;

const lifeFile = (storageRoot: string, dataPath: string): string =>
  path.join(storageRoot, 'sync', path.basename(dataPath) + '-life.json');
export const readLife = (storageRoot: string, dataPath: string): LifeT | null =>
  readValid(Life, lifeFile(storageRoot, dataPath));
export const writeLife = (storageRoot: string, dataPath: string, life: LifeT): void =>
  writeJsonAtomic(lifeFile(storageRoot, dataPath), life);

/** At launch: a fresh record (the previous one has been reported by then). */
export const startLife = (storageRoot: string, dataPath: string, keepAwake: boolean, now = new Date()): void =>
  writeLife(storageRoot, dataPath, { started: now.toISOString(), lastSeen: now.toISOString(), keepAwake });

/** Every minute while the sandbox runs. */
export const beatLife = (storageRoot: string, dataPath: string, now = new Date()): void => {
  const life = readLife(storageRoot, dataPath);
  if (life && !life.ended) writeLife(storageRoot, dataPath, { ...life, lastSeen: now.toISOString() });
};

/** The watcher saw the sandbox close while this PC kept running: closed by you (no cause), or by sleep / low memory. */
export const endLife = (storageRoot: string, dataPath: string, cause: StopCause | null, now = new Date()): void => {
  const life = readLife(storageRoot, dataPath);
  if (life && !life.ended) writeLife(storageRoot, dataPath, { ...life, ended: { at: now.toISOString(), cause } });
};
