import path from 'node:path';
import { z } from 'zod';
import { readValid, writeJsonAtomic } from '../../shared/io/index.js';
import { type ViewOptions } from './view.js';

// ---- the views the watcher keeps in step (host-only, next to the sync state) ------------------------------------------

const ActiveView = z.object({
  host: z.string().max(1024),
  view: z.string().max(1024),
  state: z.string().max(1024),
  exclude: z.array(z.string().max(500)).max(500),
  include: z.array(z.string().max(500)).max(500),
  guestGitDir: z.string().max(1024).nullable(),
});
const activeFile = (storageRoot: string, dataPath: string): string =>
  path.join(storageRoot, 'sync', path.basename(dataPath) + '-views.json');

export const saveActiveViews = (storageRoot: string, dataPath: string, views: ViewOptions[]): void =>
  writeJsonAtomic(
    activeFile(storageRoot, dataPath),
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
  readValid(z.array(ActiveView).max(64), activeFile(storageRoot, dataPath)) ?? [];
