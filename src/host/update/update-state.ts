// <root>\update-state.json: when the updater last asked GitHub, which version it installed before the current one (what
// a rollback returns to), and the version that failed last (never retried, only a newer one is).
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';

const StateSchema = z.object({
  lastCheck: z.string().optional(),
  previous: z.string().optional(),
  failed: z.object({ version: z.string(), at: z.string(), reason: z.string() }).optional(),
  lastResult: z.object({ version: z.string(), ok: z.boolean(), at: z.string() }).optional(),
});

export type UpdateState = z.infer<typeof StateSchema>;

export class UpdateStateFile {
  private readonly store: JsonFile<UpdateState>;

  constructor(root: string) {
    this.store = new JsonFile(StateSchema, path.join(root, 'update-state.json'));
  }

  /** The saved state, or an empty one when the file is missing or unreadable (a damaged record blocks nothing). */
  read(): UpdateState {
    return this.store.read() ?? {};
  }

  update(change: (state: UpdateState) => UpdateState): UpdateState {
    return this.store.update((current) => change(current ?? {}));
  }
}
