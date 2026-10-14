// The footer: only the keys that work on this screen, dropping the least important when the terminal is narrow.
import { Text } from './text.js';
import { Theme } from './theme.js';

/** [key, what it does]. */
export type KeyHint = [string, string];

export class KeyBar {
  /**
   * One line. Keys are listed by importance (first = most important, the last one is kept too: it is how you leave).
   * When they do not fit, the ones just before the last are dropped first.
   */
  static render(keys: readonly KeyHint[], width: number): string {
    const line = (list: readonly KeyHint[]): string =>
      ' ' + list.map(([k, what]) => Theme.key(k) + ' ' + Theme.muted(what)).join('  ');
    let shown = [...keys];
    while (shown.length > 1 && Text.width(line(shown)) > width - 1) shown.splice(shown.length - 2, 1);
    if (Text.width(line(shown)) > width - 1) shown = shown.slice(-1);
    return Text.truncate(line(shown), width - 1);
  }
}
