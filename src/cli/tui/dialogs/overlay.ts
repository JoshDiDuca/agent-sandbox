// A dialog drawn in a box over the screen it was opened from (that screen stays visible, dimmed, around the box).
import type { FrameParts } from '../frame.js';
import type { Screen, Size, Step } from '../screen.js';
import type { Key } from '../terminal.js';
import { Text } from '../text.js';
import { Theme } from '../theme.js';

export interface OverlayChoice<T> {
  readonly value: T;
  readonly label: string;
  /** Pressing this letter picks it. */
  readonly key: string;
  readonly danger?: boolean;
}

export interface OverlayOptions<T> {
  readonly title: string;
  readonly lines: readonly string[];
  readonly choices: readonly OverlayChoice<T>[];
  /** Index of the choice that is highlighted first. */
  readonly initial?: number;
  /** Chosen by Esc. */
  readonly escape: T;
}

/** Columns [from, to) of plain text. */
function sliceColumns(plain: string, from: number, to: number): string {
  let column = 0;
  let out = '';
  for (const ch of plain) {
    const w = Text.charWidth(ch.codePointAt(0)!);
    if (column >= from && column + w <= to) out += ch;
    column += w;
  }
  return out;
}

/** `box` drawn over the middle of `base` rows; what is around the box is dimmed. Pure. */
export function overlayBox(base: readonly string[], box: readonly string[], width: number): string[] {
  const boxWidth = Math.max(...box.map((l) => Text.width(l)));
  const left = Math.max(0, Math.floor((width - 1 - boxWidth) / 2));
  const top = Math.max(0, Math.floor((base.length - box.length) / 2));
  return base.map((row, i) => {
    const plain = Text.fit(Text.strip(row), width - 1);
    const line = box[i - top];
    if (line === undefined) return Theme.dim(plain);
    return (
      Theme.dim(sliceColumns(plain, 0, left)) +
      '\x1b[0m' +
      Text.fit(line, boxWidth) +
      '\x1b[0m' +
      Theme.dim(sliceColumns(plain, left + boxWidth, width - 1))
    );
  });
}

/** The box itself: a title, the lines and the choices as buttons. Pure. */
export function dialogBox(
  o: Pick<OverlayOptions<unknown>, 'title' | 'lines'> & { buttons: string },
  maxWidth: number,
): string[] {
  const inner = Math.max(24, Math.min(maxWidth - 6, 64));
  const wrapped = o.lines.flatMap((l) => (l === '' ? [''] : Text.wrap(l, inner)));
  const edge = (text: string): string =>
    Theme.accent(Theme.glyph.vline) + ' ' + Text.fit(text, inner) + ' ' + Theme.accent(Theme.glyph.vline);
  const rule = (l: string, r: string): string => Theme.accent(l + Theme.glyph.line.repeat(inner + 2) + r);
  return [
    rule('┌', '┐'),
    edge(Theme.bold(o.title)),
    edge(''),
    ...wrapped.map((l) => edge(l)),
    edge(''),
    edge(o.buttons),
    rule('└', '┘'),
  ];
}

/** Shows `background` with a dialog over it. Left/right or the letters choose, Enter confirms, Esc cancels. */
export class OverlayScreen<T> implements Screen<T> {
  private index: number;

  constructor(
    private readonly background: Pick<Screen<unknown>, 'render'>,
    private readonly o: OverlayOptions<T>,
  ) {
    this.index = o.initial ?? 0;
  }

  render(size: Size): FrameParts {
    const parts = this.background.render(size);
    const buttons = this.o.choices
      .map((c, i) => {
        const text = ' ' + c.label + ' ';
        if (i !== this.index) return Theme.muted(text);
        return c.danger && Theme.colour ? '\x1b[48;5;160m\x1b[97m' + text + '\x1b[0m' : Theme.selected(text);
      })
      .join('  ');
    const box = dialogBox({ title: this.o.title, lines: this.o.lines, buttons: buttons }, size.width);
    const body = parts.body.slice(0, size.height);
    while (body.length < size.height) body.push('');
    return {
      ...parts,
      body: overlayBox(body, box, size.width),
      notice: undefined,
      keys: [
        ['←→', 'choose'],
        ['↵', 'confirm'],
        ...this.o.choices.map((c) => [c.key, c.label.toLowerCase()] as [string, string]),
        ['esc', 'cancel'],
      ],
    };
  }

  handle(key: Key): Step<T> {
    if (key.name === 'left') {
      this.index = (this.index + this.o.choices.length - 1) % this.o.choices.length;
      return;
    }
    if (key.name === 'right' || key.name === 'tab') {
      this.index = (this.index + 1) % this.o.choices.length;
      return;
    }
    if (key.name === 'return') return { done: this.o.choices[this.index].value };
    if (key.name === 'escape') return { done: this.o.escape };
    const pressed = key.text.toLowerCase();
    const hit = pressed ? this.o.choices.find((c) => c.key === pressed) : undefined;
    if (hit) return { done: hit.value };
    return;
  }
}
