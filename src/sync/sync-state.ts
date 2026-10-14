import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../shared/io/index.js';
import { hostStateFile, storageOf } from '../host/storage/index.js';

/** Host-only record of the last launch: which folders map to each other and what syncs (from the effective config). */
const AbsolutePathSchema = z
  .string()
  .max(1024)
  .refine((p) => path.isAbsolute(p), 'must be an absolute path');
const SyncStateSchema = z.object({
  hostClaudeDir: AbsolutePathSchema,
  hostWorkspace: AbsolutePathSchema,
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
    .array(z.object({ hostWorkspace: AbsolutePathSchema, guestWorkspace: z.string().max(1024) }))
    .max(256)
    .optional(),
});
export type SyncState = z.output<typeof SyncStateSchema>;

/**
 * Host-only: <storage>\sync\<dataName>.json. It records which folder on this PC history flows back into, so it must
 * never live in the data folder the sandbox can write (a forged copy could redirect writes anywhere on this PC).
 */
export function syncStatePath(dataPath: string): string {
  return hostStateFile(storageOf(dataPath), dataPath, '.json');
}
/**
 * A state file that is missing, oversized or not in this shape counts as no state (nothing syncs back until the next
 * launch).
 */
export function readSyncState(dataPath: string): SyncState | null {
  return new JsonFile(SyncStateSchema, syncStatePath(dataPath)).read();
}
export function writeSyncState(dataPath: string, state: SyncState): void {
  return new JsonFile(SyncStateSchema, syncStatePath(dataPath)).write(state);
}
