// The footer: only the keys that work on this screen. When the terminal is narrow the least important keys go first.
import { Text } from './text.js';
import { Theme } from './theme.js';

/** [key, what it does, importance]: importance 0 is never dropped, a bigger number goes earlier (default 5). */
export type KeyHint = [string, string, number?];

export class KeyBar {
  static render(keys: readonly KeyHint[], width: number): string {
    const line = (list: readonly KeyHint[]): string =>
      ' ' + list.map(([k, what]) => Theme.key(k) + ' ' + Theme.muted(what)).join('  ');
    const shown = [...keys];
    const importance = (k: KeyHint): number => k[2] ?? 5;
    while (Text.width(line(shown)) > width - 1) {
      // The least important one goes; of equals, the one further right.
      let drop = -1;
      shown.forEach((k, i) => {
        if (importance(k) > 0 && (drop < 0 || importance(k) >= importance(shown[drop]))) drop = i;
      });
      if (drop < 0) break;
      shown.splice(drop, 1);
    }
    return Text.truncate(line(shown), width - 1);
  }
}
