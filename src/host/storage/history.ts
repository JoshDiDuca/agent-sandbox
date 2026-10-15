// What this PC remembers about where the data was and whether to offer moving it: <userDir>\storage-history.json, kept
// outside the storage root (it has to be found when the root is empty or missing).
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';

const MAX_PREVIOUS = 10;
/** "Not now" is not asked again for this long. */
export const NOT_NOW_DAYS = 14;

const HistorySchema = z.object({
  /** Storage roots that held data before, newest first. */
  previous: z.array(z.string().min(1).max(1024)).max(MAX_PREVIOUS),
  /** "Don't ask again" for the offer to move the data to the default folder. */
  dontAsk: z.boolean(),
  /** ISO time of the last "Not now". */
  notNowAt: z.string().nullable(),
});

export type StorageHistoryData = z.infer<typeof HistorySchema>;

const EMPTY: StorageHistoryData = { previous: [], dontAsk: false, notNowAt: null };

export class StorageHistory {
  private readonly store: JsonFile<StorageHistoryData>;

  constructor(userDir: string) {
    this.store = new JsonFile(HistorySchema, path.join(userDir, 'storage-history.json'));
  }

  read(): StorageHistoryData {
    return this.store.read() ?? EMPTY;
  }

  /** Remembers a folder that held (or holds) the data. */
  remember(root: string): void {
    const key = path.resolve(root).toLowerCase();
    const data = this.read();
    const others = data.previous.filter((p) => path.resolve(p).toLowerCase() !== key);
    this.store.write({ ...data, previous: [path.resolve(root), ...others].slice(0, MAX_PREVIOUS) });
  }

  setDontAsk(): void {
    this.store.write({ ...this.read(), dontAsk: true });
  }

  setNotNow(now: Date = new Date()): void {
    this.store.write({ ...this.read(), notNowAt: now.toISOString() });
  }

  /** The offer may be shown: not switched off and not postponed recently. */
  mayAsk(now: Date = new Date()): boolean {
    const data = this.read();
    if (data.dontAsk) return false;
    if (!data.notNowAt) return true;
    const at = Date.parse(data.notNowAt);
    return Number.isNaN(at) || now.getTime() - at > NOT_NOW_DAYS * 24 * 3600 * 1000;
  }
}
