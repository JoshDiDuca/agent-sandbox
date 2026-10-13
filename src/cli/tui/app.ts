// The menu as an application: screens are shown one at a time in the frame, each until it is done. Commands that print
// (or take over the terminal) run with the terminal handed back, and the next screen takes it again.
import { ConfirmScreen, MessageScreen, TextScreen, type ConfirmOptions, type TextOptions } from './dialogs.js';
import { Frame, type FrameParts } from './frame.js';
import { ListScreen, type ListOptions, type ListResult } from './list-screen.js';
import { Terminal, type Key } from './terminal.js';
import { Theme } from './theme.js';

export interface Size {
  width: number;
  height: number;
}
/** What a screen's key handler returns: `{ done: value }` ends the screen, nothing keeps it open (and redraws it). */
export type Step<T> = { done: T } | undefined | void;

export interface Screen<T> {
  render(size: Size): FrameParts;
  handle(key: Key): Step<T> | Promise<Step<T>>;
}

export class App {
  /** The status line for screens that do not set their own (refreshed on every draw). */
  status: () => string = () => '';

  constructor(readonly terminal: Terminal = new Terminal()) {}

  /** Shows `screen` until its handler says it is done, and returns what it returned. */
  async show<T>(screen: Screen<T>): Promise<T> {
    this.terminal.start();
    const draw = (): void => {
      const { width, height } = this.terminal;
      const parts = screen.render({ width, height: Frame.bodyHeight(height) });
      this.terminal.render(Frame.render({ ...parts, status: parts.status ?? this.status() }, width, height));
    };
    this.terminal.onResized(draw);
    try {
      for (;;) {
        draw();
        const step = await screen.handle(await this.terminal.key());
        if (step) return step.done;
      }
    } finally {
      this.terminal.onResized(null);
    }
  }

  list<T>(o: ListOptions<T>): Promise<ListResult<T>> {
    return this.show(new ListScreen(o));
  }
  text(o: TextOptions): Promise<string | undefined> {
    return this.show(new TextScreen(o));
  }
  confirm(o: ConfirmOptions): Promise<boolean> {
    return this.show(new ConfirmScreen(o));
  }
  message(o: ConstructorParameters<typeof MessageScreen>[0]): Promise<void> {
    return this.show(new MessageScreen(o));
  }

  /** One of a few values (undefined = back). */
  async choose<T>(
    path: string[],
    intro: string,
    choices: { value: T; label: string; description?: string; hint?: string }[],
    current?: T,
  ): Promise<T | undefined> {
    const picked = await this.list({
      path,
      intro,
      items: choices.map((c) => ({
        ...c,
        icon: c.value === current ? Theme.ok(Theme.glyph.on) : Theme.muted(Theme.glyph.off),
      })),
      startAt: current,
    });
    return picked.kind === 'pick' ? picked.value : undefined;
  }

  /** Runs `work` on the normal screen (command output, interactive commands); the next show() takes the screen back. */
  async suspend<T>(work: () => Promise<T>): Promise<T> {
    this.terminal.stop();
    return work();
  }

  /** Leaves the alternate screen for good. */
  close(): void {
    this.terminal.stop();
  }
}
