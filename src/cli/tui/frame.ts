// The frame every screen is drawn in: a title bar with where you are, the tabs, a status line, the screen's own body
// and a footer with the keys that work here.
import { KeyBar } from './key-bar.js';
import { TabBar, type TabInfo } from './tab-bar.js';
import { Text } from './text.js';
import { Theme } from './theme.js';

/** The tabs across the top and which one is open. */
export interface TabsState {
  readonly tabs: readonly TabInfo[];
  readonly active: number;
}

export interface FrameParts {
  /** Where you are, e.g. ['Settings', 'Languages and tools']. */
  path: string[];
  /** Short line under the title (what is running, which folder). */
  status?: string;
  body: string[];
  /** [key, what it does] pairs, most important first, e.g. [['↵', 'open'], ['esc', 'back']]. */
  keys: [string, string][];
  /** A message for the last action (saved, invalid ...), shown above the footer. */
  notice?: string;
  /** Tabs row under the title bar (added by the app for every screen of the menu). */
  tabs?: TabsState;
}

export class Frame {
  static title = 'Windows Development Sandbox';
  static version = '';

  /** Rows the body may use on a terminal `height` rows high (title, status, rules, notice, keys: 6; tabs: 1). */
  static bodyHeight(height: number, withTabs = false): number {
    return Math.max(3, height - 6 - (withTabs ? 1 : 0));
  }

  static render(parts: FrameParts, width: number, height: number): string[] {
    const w = width - 1;
    const crumbs = [Frame.title, ...parts.path]
      .map((p, i, all) => (i === all.length - 1 ? Theme.bold(p) : p))
      .join(Theme.dim(' › '));
    const right = Frame.version ? 'v' + Frame.version + ' ' : '';
    const title = Theme.bar(Text.fit(' ' + Theme.accent('◆') + ' ' + crumbs, w - Text.width(right)) + right);
    const tabs = parts.tabs ? [TabBar.render(parts.tabs.tabs, parts.tabs.active, width)] : [];
    const status = ' ' + Text.truncate(parts.status ?? '', w - 2);
    const rule = Theme.dim(Theme.glyph.line.repeat(w));
    const bodyRows = Frame.bodyHeight(height, tabs.length > 0);
    const body = parts.body.slice(0, bodyRows);
    while (body.length < bodyRows) body.push('');
    const notice = parts.notice ? ' ' + Text.truncate(parts.notice, w - 2) : '';
    return [title, ...tabs, status, rule, ...body, notice, rule, KeyBar.render(parts.keys, width)];
  }
}
