// The one-line notice a user sees on their next command after an update ran without them: it worked, or it failed and
// the old version stayed. Each user sees each outcome once (the caller remembers the key). Pure.
import { compareVersions } from '../install/layout.js';
import type { UpdateState } from './update-state.js';

export interface UpdateNotice {
  text: string;
  /** Identifies the outcome: the same key is never shown to the same user twice. */
  key: string;
}

/**
 * `current` is the version that runs now. A success is announced while it is still the current version; a blocked
 * failure while the current version is older than the one that failed. When both exist, the newer outcome wins.
 */
export function updateNotice(state: UpdateState, current: string, seenKey: string | undefined): UpdateNotice | null {
  const candidates: { at: string; notice: UpdateNotice }[] = [];
  const done = state.lastResult;
  if (done?.ok && done.version === current)
    candidates.push({ at: done.at, notice: { key: 'ok@' + done.at, text: 'Updated to ' + done.version + '.' } });
  const failed = state.failed;
  if (failed && compareVersions(failed.version, current) > 0)
    candidates.push({
      at: failed.at,
      notice: {
        key: 'failed@' + failed.at,
        text:
          'Update to ' +
          failed.version +
          ' failed; still on ' +
          current +
          ' (sandbox update --rollback, or sandbox update for details).',
      },
    });
  const newest = candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return newest && newest.notice.key !== seenKey ? newest.notice : null;
}
