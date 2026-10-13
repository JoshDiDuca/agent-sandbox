import type { FrameParts } from '../frame.js';
import type { Screen, Size, Step } from '../screen.js';
import type { Key } from '../terminal.js';
import { Text } from '../text.js';
import { Theme } from '../theme.js';

/** Text to read (scrolls); any key but the arrows closes it. */
export class MessageScreen implements Screen<void> {
  private offset = 0;
  private height = 10;
  constructor(
    private readonly o: { path: string[]; title?: string; lines: string[]; tone?: 'ok' | 'warn' | 'error' },
  ) {}

  render(size: Size): FrameParts {
    const paint =
      this.o.tone === 'ok'
        ? Theme.ok
        : this.o.tone === 'warn'
          ? Theme.warn
          : this.o.tone === 'error'
            ? Theme.error
            : Theme.bold;
    const head = this.o.title ? ['', '  ' + paint(this.o.title), ''] : [''];
    const lines = this.o.lines
      .flatMap((l) => (Text.width(l) > size.width - 4 && Text.strip(l) === l ? Text.wrap(l, size.width - 4) : [l]))
      .map((l) => '  ' + l);
    this.height = size.height - head.length;
    this.offset = Math.max(0, Math.min(this.offset, lines.length - this.height));
    return {
      path: this.o.path,
      body: [...head, ...lines.slice(this.offset, this.offset + this.height)],
      keys:
        lines.length > this.height
          ? [
              ['↑↓', 'scroll'],
              ['↵', 'close'],
            ]
          : [['any key', 'close']],
    };
  }

  handle(key: Key): Step<void> {
    if (key.name === 'up') {
      this.offset--;
      return;
    }
    if (key.name === 'down') {
      this.offset++;
      return;
    }
    if (key.name === 'pageup') {
      this.offset -= this.height;
      return;
    }
    if (key.name === 'pagedown') {
      this.offset += this.height;
      return;
    }
    return { done: undefined };
  }
}
