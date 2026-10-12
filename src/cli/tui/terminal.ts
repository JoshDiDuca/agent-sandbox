// The terminal while the menu owns it: the alternate screen (your scrollback stays as it was), raw keys, a cursor that
// is hidden, and redraws that only rewrite the rows that changed (no flicker). suspend() hands the terminal back for
// a command's own output; resume() takes it again.
import readline from 'node:readline';
import { Text } from './text.js';

/** One key press: `name` for special keys (up, return, escape, f1 ...), `text` for something typed. */
export interface Key { name: string; text: string; ctrl: boolean; meta: boolean; shift: boolean }

/** Ctrl+C: leave the menu at once (callers let it propagate to the top). */
export class ExitRequested extends Error {
  constructor() { super('Ctrl+C'); this.name = 'ExitPromptError'; }
}

export class Terminal {
  private active = false;
  private frame: string[] = [];
  private queue: Key[] = [];
  private waiting: { resolve: (key: Key) => void; reject: (e: Error) => void } | null = null;
  private resizeHandler: (() => void) | null = null;
  private readonly onKeypress = (str: string | undefined, key: readline.Key | undefined): void => this.push(str, key);
  private readonly onResize = (): void => { this.frame = []; this.resizeHandler?.(); };

  constructor(private readonly stdin: NodeJS.ReadStream = process.stdin, private readonly stdout: NodeJS.WriteStream = process.stdout) {}

  get width(): number { return Math.max(40, this.stdout.columns ?? 80); }
  get height(): number { return Math.max(12, this.stdout.rows ?? 30); }

  /** Called after the window was resized (the screen draws itself again). */
  onResized(handler: (() => void) | null): void { this.resizeHandler = handler; }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.frame = [];
    readline.emitKeypressEvents(this.stdin);
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.on('keypress', this.onKeypress);
    this.stdin.resume();
    this.stdout.on('resize', this.onResize);
    this.stdout.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J');
  }

  /** Gives the terminal back exactly as it was (also on errors: callers use try/finally). */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.stdin.off('keypress', this.onKeypress);
    this.stdout.off('resize', this.onResize);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
    this.queue = [];
    this.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  }

  get running(): boolean { return this.active; }

  /** Draws a whole screen: `lines` are cut to the width and padded to the height; unchanged rows are not rewritten. */
  render(lines: string[]): void {
    const { width, height } = this;
    // One column is left free: writing the last column can scroll older consoles.
    const rows = Array.from({ length: height }, (_, i) => Text.fit(lines[i] ?? '', width - 1));
    let out = '';
    rows.forEach((row, i) => { if (this.frame[i] !== row) out += '\x1b[' + (i + 1) + ';1H' + row + '\x1b[0m'; });
    if (this.frame.length !== rows.length) out = '\x1b[H\x1b[2J' + rows.map((r, i) => '\x1b[' + (i + 1) + ';1H' + r + '\x1b[0m').join('');
    this.frame = rows;
    if (out) this.stdout.write(out);
  }

  /** The next key press. Ctrl+C rejects with ExitRequested. */
  key(): Promise<Key> {
    const next = this.queue.shift();
    if (next) return next.ctrl && next.name === 'c' ? Promise.reject(new ExitRequested()) : Promise.resolve(next);
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }

  private push(str: string | undefined, key: readline.Key | undefined): void {
    const event: Key = { name: key?.name ?? '', text: str && !key?.ctrl && !key?.meta && str.length >= 1 && str >= ' ' && str !== '\x7f' ? str : '', ctrl: Boolean(key?.ctrl), meta: Boolean(key?.meta), shift: Boolean(key?.shift) };
    const waiting = this.waiting;
    if (!waiting) { this.queue.push(event); return; }
    this.waiting = null;
    if (event.ctrl && event.name === 'c') waiting.reject(new ExitRequested()); else waiting.resolve(event);
  }
}
