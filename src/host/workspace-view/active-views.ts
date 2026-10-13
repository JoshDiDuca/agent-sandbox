import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import { hostStateFile } from '../storage/index.js';
import { type ViewOptions } from './view.js';

// ---- the views the watcher keeps in step (host-only, next to the sync state) ------------------------------------------

const ActiveViewSchema = z.object({
  host: z.string().max(1024),
  view: z.string().max(1024),
  state: z.string().max(1024),
  exclude: z.array(z.string().max(500)).max(500),
  include: z.array(z.string().max(500)).max(500),
  guestGitDir: z.string().max(1024).nullable(),
});
const activeFile = (storageRoot: string, dataPath: string): JsonFile<z.output<typeof ActiveViewSchema>[]> =>
  new JsonFile(z.array(ActiveViewSchema).max(64), hostStateFile(storageRoot, dataPath, '-views.json'));

export const saveActiveViews = (storageRoot: string, dataPath: string, views: ViewOptions[]): void =>
  activeFile(storageRoot, dataPath).write(
    views.map((v) => ({
      host: v.host,
      view: v.view,
      state: v.state,
      exclude: v.exclude ?? [],
      include: v.include ?? [],
      guestGitDir: v.guestGitDir ?? null,
    })),
  );

export const readActiveViews = (storageRoot: string, dataPath: string): ViewOptions[] =>
  activeFile(storageRoot, dataPath).read() ?? [];
