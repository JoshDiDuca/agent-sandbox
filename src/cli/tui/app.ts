// The menu as an application: screens are shown one at a time in the frame, each until it is done. Commands that print
// (or take over the terminal) run with the terminal handed back, and the next screen takes it again.
import { ConfirmScreen, type ConfirmOptions } from './dialogs/confirm-screen.js';
import { MessageScreen } from './dialogs/message-screen.js';
import { TextScreen, type TextOptions } from './dialogs/text-screen.js';
import { OverlayScreen, type OverlayOptions } from './dialogs/overlay.js';
import { Frame, type TabsState } from './frame.js';
import { ListScreen } from './list/list-screen.js';
import { type ListOptions, type ListResult } from './list/list-types.js';
import { Terminal } from './terminal.js';
import { Theme } from './theme.js';
import type { Screen } from './screen.js';

export class App {
  /** The status line for screens that do not set their own (refreshed on every draw). */
  status: () => string = () => '';
  /** The tabs shown across the top of every screen (none: no tab row). */
  tabs: () => TabsState | undefined = () => undefined;
  /** The screens being shown, innermost last: a dialog is drawn over the one below it. */
  private readonly shown: Screen<unknown>[] = [];
  private redrawNow: (() => void) | null = null;

  constructor(readonly terminal: Terminal = new Terminal()) {}

  /** Draws the screen on top again now (before a slow piece of work, so its notice is visible). */
  redraw(): void {
    this.redrawNow?.();
  }

  /** Shows `screen` until its handler says it is done, and returns what it returned. */
  async show<T>(screen: Screen<T>): Promise<T> {
    this.terminal.start();
    this.shown.push(screen);
    const outer = this.redrawNow;
    const draw = (): void => {
      const { width, height } = this.terminal;
      const tabs = this.tabs();
      const parts = screen.render({ width, height: Frame.bodyHeight(height, Boolean(tabs)) });
      this.terminal.render(
        Frame.render({ ...parts, status: parts.status ?? this.status(), tabs: parts.tabs ?? tabs }, width, height),
      );
    };
    this.redrawNow = draw;
    this.terminal.onResized(draw);
    try {
      for (;;) {
        draw();
        const step = await screen.handle(await this.terminal.key());
        if (step) return step.done;
      }
    } finally {
      this.shown.pop();
      this.redrawNow = outer;
      this.terminal.onResized(outer);
    }
  }

  /** A dialog over the screen below (Save / Discard / Cancel, Yes / No ...). */
  dialog<T>(o: OverlayOptions<T>): Promise<T> {
    const below = this.shown[this.shown.length - 1];
    return this.show(new OverlayScreen(below ?? { render: () => ({ path: [], body: [], keys: [] }) }, o));
  }

  /** Yes or no over the current screen; Esc is no. */
  ask(title: string, lines: readonly string[], yes = 'Yes', danger = false): Promise<boolean> {
    return this.dialog<boolean>({
      title,
      lines,
      choices: [
        { value: true, label: yes, key: 'y', danger },
        { value: false, label: 'Cancel', key: 'n' },
      ],
      initial: danger ? 1 : 0,
      escape: false,
    });
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
