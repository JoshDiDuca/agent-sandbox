// The look of every screen: colours (off with NO_COLOR, like the rest of the CLI) and the line-drawing characters.
import { colorEnabled } from '../output/index.js';

const sgr =
  (open: string, close = '0') =>
  (text: string): string =>
    Theme.colour ? '\x1b[' + open + 'm' + text + '\x1b[' + close + 'm' : text;

export class Theme {
  /** Colour is decided once per run: the menu only runs in a terminal. */
  static readonly colour = colorEnabled(process.env, Boolean(process.stdout.isTTY));

  static readonly bold = sgr('1', '22');
  static readonly dim = sgr('2', '22');
  static readonly italic = sgr('3', '23');
  static readonly accent = sgr('38;5;75', '39');
  static readonly accentBold = (t: string): string => Theme.bold(Theme.accent(t));
  static readonly ok = sgr('38;5;78', '39');
  static readonly warn = sgr('38;5;214', '39');
  static readonly error = sgr('38;5;203', '39');
  static readonly muted = sgr('38;5;245', '39');
  static readonly changed = sgr('38;5;221', '39');
  /** The highlighted row: a soft background bar across the whole width. */
  static readonly selected = (t: string): string =>
    Theme.colour ? '\x1b[48;5;24m\x1b[97m' + t.replace(/\x1b\[0m/g, '\x1b[0m\x1b[48;5;24m\x1b[97m') + '\x1b[0m' : t;
  /** The header bar. */
  static readonly bar = (t: string): string =>
    Theme.colour ? '\x1b[48;5;236m\x1b[97m' + t.replace(/\x1b\[0m/g, '\x1b[0m\x1b[48;5;236m\x1b[97m') + '\x1b[0m' : t;
  /** The two settings scopes: your own (blue) and the project's (purple). */
  static readonly scopeGlobal = (t: string): string =>
    Theme.colour ? '\x1b[48;5;25m\x1b[97m\x1b[1m' + t + '\x1b[0m' : '[' + t + ']';
  static readonly scopeProject = (t: string): string =>
    Theme.colour ? '\x1b[48;5;91m\x1b[97m\x1b[1m' + t + '\x1b[0m' : '[' + t + ']';
  static readonly project = sgr('38;5;177', '39');
  static readonly key = (t: string): string =>
    Theme.colour ? '\x1b[48;5;238m\x1b[97m ' + t + ' \x1b[0m' : '[' + t + ']';

  static readonly glyph = {
    pointer: '›',
    bullet: '•',
    on: '●',
    off: '○',
    checked: '◉',
    unchecked: '◯',
    dot: '·',
    arrow: '→',
    back: '←',
    more: '…',
    folder: '▸',
    open: '▾',
    line: '─',
    vline: '│',
    search: '⌕',
    changed: '✎',
    lock: '⚿',
    ok: '✔',
    cross: '✘',
    star: '★',
  };
}
