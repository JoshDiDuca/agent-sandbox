// The frame every screen is drawn in: a title bar with where you are, a status line, the screen's own body and a footer
// with the keys that work here.
import { Text } from './text.js';
import { Theme } from './theme.js';

export interface FrameParts {
  /** Where you are, e.g. ['Settings', 'Languages and tools']. */
  path: string[];
  /** Short line under the title (what is running, which folder). */
  status?: string;
  body: string[];
  /** [key, what it does] pairs, e.g. [['↵', 'open'], ['esc', 'back']]. */
  keys: [string, string][];
  /** A message for the last action (saved, invalid ...), shown above the footer. */
  notice?: string;
}

export class Frame {
  static title = 'Windows Development Sandbox';
  static version = '';

  /** Rows the body may use on a terminal `height` rows high (title, status, two rules, notice and keys take 6). */
  static bodyHeight(height: number): number {
    return Math.max(3, height - 6);
  }

  static render(parts: FrameParts, width: number, height: number): string[] {
    const w = width - 1;
    const crumbs = [Frame.title, ...parts.path]
      .map((p, i, all) => (i === all.length - 1 ? Theme.bold(p) : p))
      .join(Theme.dim(' › '));
    const right = Frame.version ? 'v' + Frame.version + ' ' : '';
    const title = Theme.bar(Text.fit(' ' + Theme.accent('◆') + ' ' + crumbs, w - Text.width(right)) + right);
    const status = ' ' + Text.truncate(parts.status ?? '', w - 2);
    const rule = Theme.dim(Theme.glyph.line.repeat(w));
    const bodyRows = Frame.bodyHeight(height);
    const body = parts.body.slice(0, bodyRows);
    while (body.length < bodyRows) body.push('');
    const notice = parts.notice ? ' ' + Text.truncate(parts.notice, w - 2) : '';
    const keys = ' ' + parts.keys.map(([k, what]) => Theme.key(k) + ' ' + Theme.muted(what)).join('  ');
    return [title, status, rule, ...body, notice, rule, Text.truncate(keys, w)];
  }
}
