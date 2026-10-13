import type { FrameParts } from '../frame.js';
import type { Screen, Size, Step } from '../screen.js';
import type { Key } from '../terminal.js';
import { Theme } from '../theme.js';
import { paragraphs } from './paragraphs.js';

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
