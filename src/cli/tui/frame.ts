// The frame every screen is drawn in: a title bar with where you are, a status line, the navigation on the left, the
// screen's own body and a footer with the keys that work here.
import { KeyBar, type KeyHint } from './key-bar.js';
import { SideNav, type NavState } from './nav.js';
import { Text } from './text.js';
import { Theme } from './theme.js';

export interface FrameParts {
  /** Where you are, e.g. ['Settings', 'Languages and tools']. */
  path: string[];
  /** Short line under the title (what is running, which folder). */
  status?: string;
  body: string[];
  /** [key, what it does] pairs, most important first, e.g. [['↵', 'open'], ['esc', 'back']]. */
  keys: KeyHint[];
  /** A message for the last action (saved, invalid ...), shown above the footer. */
  notice?: string;
  /** The navigation on the left (added by the app for every screen of the menu). */
  nav?: NavState;
}

export class Frame {
  static title = 'Windows Development Sandbox';
  static version = '';

  /** Rows the body may use on a terminal `height` rows high (title, status, rules, notice, keys: 6). */
  static bodyHeight(height: number): number {
    return Math.max(3, height - 6);
  }

  /** Columns the body may use on a terminal `width` columns wide: what the navigation and its divider leave. */
  static bodyWidth(width: number, nav?: NavState): number {
    return nav ? Math.max(20, width - SideNav.width(width) - 1) : width;
  }

  static render(parts: FrameParts, width: number, height: number): string[] {
    const w = width - 1;
    const crumbs = [Frame.title, ...parts.path]
      .map((p, i, all) => (i === all.length - 1 ? Theme.bold(p) : p))
      .join(Theme.dim(' › '));
    const right = Frame.version ? 'v' + Frame.version + ' ' : '';
    const title = Theme.bar(Text.fit(' ' + Theme.accent('◆') + ' ' + crumbs, w - Text.width(right)) + right);
    const status = ' ' + Text.truncate(parts.status ?? '', w - 2);
    const bodyRows = Frame.bodyHeight(height);
    const navWidth = parts.nav ? SideNav.width(width) : 0;
    const line = (joint: string): string =>
      Theme.dim(
        navWidth && navWidth + 1 < w
          ? Theme.glyph.line.repeat(navWidth) + joint + Theme.glyph.line.repeat(w - navWidth - 1)
          : Theme.glyph.line.repeat(w),
      );
    const side = parts.nav ? SideNav.render(parts.nav, width, bodyRows) : [];
    const divider = Theme.dim(Theme.glyph.vline);
    const body = parts.body.slice(0, bodyRows);
    while (body.length < bodyRows) body.push('');
    const rows = parts.nav ? body.map((row, i) => (side[i] ?? ' '.repeat(navWidth)) + divider + row) : body;
    const notice = parts.notice ? ' ' + Text.truncate(parts.notice, w - 2) : '';
    return [title, status, line('┬'), ...rows, notice, line('┴'), KeyBar.render(parts.keys, width)];
  }
}
