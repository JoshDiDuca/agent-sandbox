// The tabs across the top of every screen: a number and a name each, shortened when the terminal is narrow.
import { Text } from './text.js';
import { Theme } from './theme.js';

export interface TabInfo {
  readonly label: string;
  /** Something is waiting in this tab (unsaved changes). */
  readonly marked?: boolean;
}

export class TabBar {
  /** One line, exactly `width` columns wide: full names, then tighter, then numbers, then only the open tab. */
  static render(tabs: readonly TabInfo[], active: number, width: number): string {
    const paint = (text: string, on: boolean): string => (on ? Theme.selected(text) : Theme.muted(text));
    const mark = (tab: TabInfo): string => (tab.marked ? Theme.changed(Theme.glyph.changed) : '');
    const build = (pad: number, shown: (i: number) => string): string =>
      tabs
        .map((tab, i) => {
          const text = shown(i) + (tab.marked ? ' ' + Text.strip(mark(tab)) : '');
          // The open tab is in brackets too, so it shows without colour.
          if (i === active) {
            const space = ' '.repeat(Math.max(0, pad - 1));
            return paint(space + '[' + text + ']' + space, true);
          }
          return paint(' '.repeat(pad) + text + ' '.repeat(pad), false);
        })
        .join('');
    const full = (i: number): string => i + 1 + ' ' + tabs[i].label;
    const attempts: string[] = [
      build(2, full),
      build(1, full),
      build(1, (i) => (i === active ? full(i) : String(i + 1))),
      build(0, (i) => (i === active ? full(i) : String(i + 1))),
    ];
    const fits = attempts.find((line) => Text.width(line) <= width - 1);
    if (fits) return Text.fit(fits, width);
    const only = '[' + (active + 1) + '/' + tabs.length + ' ' + tabs[active].label + ']';
    return Text.fit(Theme.selected(only), width);
  }
}
