// The record of which migrations ran: <userDir>\migrations.json. A missing file means nothing has run yet (older than
// 1.5); a file that is there but unreadable stops the run rather than re-running everything.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fail } from '../../core/util/index.js';
import { JsonFile } from '../../shared/io/index.js';

export const MIGRATION_ID = /^[a-z0-9-]{1,80}$/;
const MAX_APPLIED = 500;

const MarkerSchema = z.object({
  lastVersion: z.string(),
  applied: z
    .array(z.object({ id: z.string().regex(MIGRATION_ID), at: z.string(), backup: z.string().nullable() }))
    .max(MAX_APPLIED),
});

export type Marker = z.infer<typeof MarkerSchema>;

export class MigrationMarker {
  private readonly store: JsonFile<Marker>;

  constructor(userDir: string) {
    this.store = new JsonFile(MarkerSchema, path.join(userDir, 'migrations.json'));
  }

  get file(): string {
    return this.store.file;
  }

  read(): Marker {
    if (!fs.existsSync(this.store.file)) return { lastVersion: '0.0.0', applied: [] };
    const marker = this.store.read();
    if (!marker)
      fail(
        'The migrations record ' + this.store.file + ' is not readable.',
        'Rename or delete that file (your settings are not changed); the next start checks each change again.',
      );
    return marker;
  }

  record(id: string, backup: string | null): void {
    if (!MIGRATION_ID.test(id)) fail('Migration id "' + id + '" is not kebab-case.');
    const marker = this.read();
    if (marker.applied.length >= MAX_APPLIED)
      fail('The migrations record has ' + MAX_APPLIED + ' entries.', 'Report this: the record needs pruning.');
    this.store.write({
      ...marker,
      applied: [...marker.applied, { id, at: new Date().toISOString(), backup }],
    });
  }

  setVersion(version: string): void {
    this.store.write({ ...this.read(), lastVersion: version });
  }

  has(id: string): boolean {
    return this.read().applied.some((entry) => entry.id === id);
  }
}
