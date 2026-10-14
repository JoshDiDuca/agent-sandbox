// One record per running sandbox, written by the Windows user who started it: who owns it, which Windows session its
// window is in, and whether other users may use it. Other users read these to tell them whose sandbox this is. Records
// come from the folder other users can write into, so every one is validated, and links are never followed.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readValid, safeRemove, writeJsonAtomic } from '../../shared/io/index.js';

const SID = /^S-1-[0-9-]{3,180}$/;
const TEXT = z.string().max(1024);
/** A record is a few hundred bytes; anything much bigger is not one of ours. */
const MAX_RECORD_BYTES = 64 * 1024;

export const ActiveSandboxSchema = z.strictObject({
  user: z.string().max(256),
  sid: z.string().regex(SID, 'a Windows SID like S-1-5-21-...'),
  windowsSession: z.number().int().nonnegative(),
  dataPath: TEXT,
  shared: z.boolean(),
  startedAt: z.string().max(64),
  version: z.string().max(64),
  projects: z.array(z.strictObject({ id: z.string().max(256), hostPath: TEXT, guestPath: TEXT })).max(64),
});
export type ActiveSandbox = z.infer<typeof ActiveSandboxSchema>;

export class ActiveRecords {
  constructor(readonly dir: string) {}

  /** Writes this user's record (atomically: readers never see half of it). */
  write(record: ActiveSandbox): void {
    const valid = ActiveSandboxSchema.parse(record);
    writeJsonAtomic(this.fileOf(valid.sid), valid);
  }

  /** Every valid record. A missing folder, a corrupt file, a link, or a file whose name is not its SID is skipped. */
  readAll(): ActiveSandbox[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const records: ActiveSandbox[] = [];
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) continue;
      const record = readValid(ActiveSandboxSchema, file);
      if (record && name === record.sid + '.json') records.push(record);
    }
    return records;
  }

  /** Removes this user's record (a link is removed itself, never followed). */
  clear(sid: string): void {
    safeRemove(this.fileOf(sid), this.dir);
  }

  private fileOf(sid: string): string {
    if (!SID.test(sid)) throw new Error('Not a Windows SID: ' + sid);
    return path.join(this.dir, sid + '.json');
  }
}
