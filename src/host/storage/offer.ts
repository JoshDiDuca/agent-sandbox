// When to offer moving the saved data: after an upgrade (it is in the old per-user folder, the default is a new one),
// after switching the install type, or after a downgrade and upgrade (the configured folder is empty while an earlier
// one holds the data). Pure apart from looking at the folders.
import path from 'node:path';
import type { StorageHistory } from './history.js';
import { moveProblem } from './move.js';
import { holdsData, oldDefaultRoot, sharedDefaultRoot } from './root.js';

export interface MoveOffer {
  readonly from: string;
  readonly to: string;
  /** `to` is the shared default folder (the wording says "the default folder"). */
  readonly toIsDefault: boolean;
}

const same = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Folders that may hold saved data, other than `current`: the old default, the shared default, the remembered ones. */
export function otherDataFolders(
  current: string,
  history: StorageHistory,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const old = oldDefaultRoot(env);
  const candidates = [old, sharedDefaultRoot(), ...history.read().previous].filter((p): p is string => Boolean(p));
  const unique = candidates.filter((p, i) => candidates.findIndex((q) => same(p, q)) === i);
  return unique.filter((p) => !same(p, current) && holdsData(p));
}

/** What to offer, or null (nothing to move, the user said no, or the move would not be allowed anyway). */
export function planOffer(
  current: string,
  history: StorageHistory,
  env: NodeJS.ProcessEnv = process.env,
): MoveOffer | null {
  if (!history.mayAsk()) return null;
  const shared = sharedDefaultRoot();
  const old = oldDefaultRoot(env);
  let offer: MoveOffer | null = null;
  if (holdsData(current)) {
    // Still in the old per-user folder (pinned by the upgrade): the new default is where it should go. A folder
    // chosen on purpose is never asked about.
    if (old && same(current, old) && !same(shared, current) && !holdsData(shared))
      offer = { from: current, to: shared, toIsDefault: true };
  } else {
    const from = otherDataFolders(current, history, env)[0];
    if (from) offer = { from, to: current, toIsDefault: same(current, shared) };
  }
  if (!offer || moveProblem(offer.from, offer.to)) return null;
  return offer;
}
