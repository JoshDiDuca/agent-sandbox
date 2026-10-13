// The small screens: typing a value (with checking as you type), yes/no, and a message to read.
import type { FrameParts } from './frame.js';
import type { Screen, Size, Step } from './app.js';
import type { Key } from './terminal.js';
import { Text } from './text.js';
import { Theme } from './theme.js';

/** Plain lines are wrapped to the width; coloured ones are kept as they are (the frame cuts them). */
const paragraphs = (lines: string[], width: number): string[] =>
  lines.flatMap((l) => (Text.strip(l) === l ? Text.wrap(l, width - 4) : [l]).map((x) => '  ' + x));

export interface TextOptions {
  path: string[];
  label: string;
  /** Explanation above the field (plain lines). */
  about?: string[];
  initial?: string;
  placeholder?: string;
  /** true = fine, a string = what is wrong (shown under the field). */
  validate?: (value: string) => true | string;
  /** Allow an empty answer (otherwise Enter on an empty field cancels). */
  allowEmpty?: boolean;
}

/** One line of text. Resolves to the text, or undefined when you press Esc. */
export class TextScreen implements Screen<string | undefined> {
  private value: string;
  private cursor: number;
  private problem: string | undefined;

  constructor(private readonly o: TextOptions) {
    this.value = o.initial ?? '';
    this.cursor = [...this.value].length;
  }

  render(size: Size): FrameParts {
    const width = Math.min(size.width - 4, 100);
    const chars = [...this.value];
    // Scroll the field so the cursor stays visible.
    const inner = width - 4;
    const start = Math.max(0, this.cursor - inner + 1);
    const shown = chars.slice(start, start + inner);
    const before = shown.slice(0, this.cursor - start).join('');
    const at = shown[this.cursor - start] ?? ' ';
    const after = shown.slice(this.cursor - start + 1).join('');
    const text =
      this.value === '' && this.o.placeholder
        ? Theme.muted(this.o.placeholder)
        : before + (Theme.colour ? '\x1b[7m' + at + '\x1b[27m' : '_') + after;
    const body = [
      '',
      '  ' + Theme.bold(this.o.label),
      ...(this.o.about?.length ? paragraphs(this.o.about, size.width).map((l) => Theme.muted(l)) : []),
      '',
      '  ' + Theme.accent('╭' + '─'.repeat(width - 2) + '╮'),
      '  ' + Theme.accent('│') + ' ' + Text.fit(text, inner) + ' ' + Theme.accent('│'),
      '  ' + Theme.accent('╰' + '─'.repeat(width - 2) + '╯'),
      this.problem ? '  ' + Theme.error(Theme.glyph.cross + ' ' + this.problem) : '',
    ];
    return {
      path: this.o.path,
      body,
      keys: [
        ['↵', 'save'],
        ['esc', 'cancel'],
        ['ctrl+u', 'clear'],
        ['←→', 'move'],
      ],
    };
  }

  handle(key: Key): Step<string | undefined> {
    const chars = [...this.value];
    const set = (next: string[], cursor: number): void => {
      this.value = next.join('');
      this.cursor = Math.max(0, Math.min(next.length, cursor));
      this.check();
    };
    if (key.name === 'escape') return { done: undefined };
    if (key.name === 'return') {
      if (this.value === '' && !this.o.allowEmpty) return { done: undefined };
      const verdict = this.o.validate?.(this.value) ?? true;
      if (verdict !== true) {
        this.problem = verdict;
        return;
      }
      return { done: this.value };
    }
    if (key.name === 'left') {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (key.name === 'right') {
      this.cursor = Math.min(chars.length, this.cursor + 1);
      return;
    }
    if (key.name === 'home') {
      this.cursor = 0;
      return;
    }
    if (key.name === 'end') {
      this.cursor = chars.length;
      return;
    }
    if (key.name === 'backspace') {
      if (this.cursor > 0) set([...chars.slice(0, this.cursor - 1), ...chars.slice(this.cursor)], this.cursor - 1);
      return;
    }
    if (key.name === 'delete') {
      set([...chars.slice(0, this.cursor), ...chars.slice(this.cursor + 1)], this.cursor);
      return;
    }
    if (key.ctrl && key.name === 'u') {
      set([], 0);
      return;
    }
    if (key.text) {
      const add = [...key.text.replace(/[\r\n]/g, '')];
      set([...chars.slice(0, this.cursor), ...add, ...chars.slice(this.cursor)], this.cursor + add.length);
    }
    return;
  }

  private check(): void {
    const verdict = this.value === '' ? true : (this.o.validate?.(this.value) ?? true);
    this.problem = verdict === true ? undefined : verdict;
  }
}

export interface ConfirmOptions {
  path: string[];
  question: string;
  about?: string[];
  yes?: string;
  no?: string;
  initial?: boolean;
  danger?: boolean;
}

/** Yes or no. Esc answers no. */
export class ConfirmScreen implements Screen<boolean> {
  private yes: boolean;
  constructor(private readonly o: ConfirmOptions) {
    this.yes = o.initial ?? true;
  }

  render(size: Size): FrameParts {
    const button = (label: string, on: boolean, danger = false): string =>
      on
        ? danger
          ? Theme.colour
            ? '\x1b[48;5;160m\x1b[97m ' + label + ' \x1b[0m'
            : '[' + label + ']'
          : Theme.selected(' ' + label + ' ')
        : Theme.muted(' ' + label + ' ');
    const body = [
      '',
      '  ' + Theme.bold(this.o.question),
      ...(this.o.about?.length ? ['', ...paragraphs(this.o.about, size.width)] : []),
      '',
      '  ' + button(this.o.yes ?? 'Yes', this.yes, this.o.danger) + '   ' + button(this.o.no ?? 'No', !this.yes),
    ];
    return {
      path: this.o.path,
      body,
      keys: [
        ['←→', 'choose'],
        ['↵', 'confirm'],
        ['y/n', 'answer'],
        ['esc', 'no'],
      ],
    };
  }

  handle(key: Key): Step<boolean> {
    if (key.name === 'left' || key.name === 'right' || key.name === 'tab') {
      this.yes = !this.yes;
      return;
    }
    if (key.text?.toLowerCase() === 'y') return { done: true };
    if (key.text?.toLowerCase() === 'n' || key.name === 'escape') return { done: false };
    if (key.name === 'return') return { done: this.yes };
    return;
  }
}

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
