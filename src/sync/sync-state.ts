import path from 'node:path';
import { z } from 'zod';
import { readValid, writeJsonAtomic } from '../shared/io/index.js';

/** Host-only record of the last launch: which folders map to each other and what syncs (from the effective config). */
const AbsolutePath = z
  .string()
  .max(1024)
  .refine((p) => path.isAbsolute(p), 'must be an absolute path');
const SyncStateSchema = z.object({
  hostClaudeDir: AbsolutePath,
  hostWorkspace: AbsolutePath,
  guestWorkspace: z.string().max(1024),
  syncHistory: z.boolean().optional(),
  syncClaudeMem: z.boolean().optional(),
  syncClaudeMemBack: z.boolean().optional(),
  historyScope: z.enum(['project', 'all']).optional(),
  /** Newest claude-mem database time on each side right after the last sync (detects edits on both sides). */
  memHostStamp: z.number().optional(),
  memGuestStamp: z.number().optional(),
  /** Projects registered while the sandbox ran (their history goes back to their own folders). */
  projects: z
    .array(z.object({ hostWorkspace: AbsolutePath, guestWorkspace: z.string().max(1024) }))
    .max(256)
    .optional(),
});
export type SyncState = z.output<typeof SyncStateSchema>;

/**
 * Host-only: <storage>\sync\<dataName>.json. It records which folder on this PC history flows back into, so it must
 * never live in the data folder the sandbox can write (a forged copy could redirect writes anywhere on this PC).
 */
export const syncStatePath = (dataPath: string): string =>
  path.join(path.dirname(path.dirname(dataPath)), 'sync', path.basename(dataPath) + '.json');
/** A state file that is missing, oversized or not in this shape counts as no state (nothing syncs back until the next launch). */
export const readSyncState = (dataPath: string): SyncState | null =>
  readValid(SyncStateSchema, syncStatePath(dataPath));
export const writeSyncState = (dataPath: string, state: SyncState): void =>
  writeJsonAtomic(syncStatePath(dataPath), state);
