// The menu's shell: tabs across the top (1-7), one page per tab, and the one rule for unsaved changes (Ctrl+S saves
// them all; leaving asks Save / Discard / Cancel). A page that needs the terminal (attach, a log, a start) ends the
// shell with what to run; the menu comes back afterwards.
import type { App, FrameParts, Key, Screen, Size, Step, TabsState } from '../tui/index.js';
import { Theme } from '../tui/index.js';
import type { Draft, DraftResult } from './settings/draft.js';

/** Why the shell closed. */
export type ShellExit =
  | { kind: 'quit' }
  /** Run a command line on the normal screen (attach, start, logs -f ...). */
  | { kind: 'run'; argv: string[] }
  /** Show the end of a log file on the normal screen. */
  | { kind: 'view'; file: string };

/** One tab. */
export interface Page {
  readonly label: string;
  /** This page stages changes in the Draft (its tab is marked while something is unsaved). */
  readonly stages: boolean;
  /** Typing goes into a search box: digits are text, not tab numbers. */
  readonly capturing: boolean;
  /** The tab was opened (or the shell came back from a command): load what it shows again. */
  open(): Promise<void>;
  render(size: Size): FrameParts;
  handle(key: Key): Promise<Step<ShellExit>> | Step<ShellExit>;
}

/** The tab names, in order. Number keys 1-7 open them. */
export const TAB_LABELS = ['Start', 'Sessions', 'Sandbox', 'Apps', 'Settings', 'Accounts', 'Maintenance'] as const;

export class Shell implements Screen<ShellExit> {
  private active = 0;
  private notice: string | undefined;

  constructor(
    private readonly app: App,
    readonly pages: readonly Page[],
    readonly draft: Draft,
    /** Told after a save (the menu applies settings that act on this PC) and returns a note to add. */
    private readonly afterSave: (result: DraftResult) => string | undefined = () => undefined,
  ) {
    app.tabs = () => this.tabs();
  }

  get page(): Page {
    return this.pages[this.active];
  }

  tabs(): TabsState {
    const unsaved = this.draft.count() > 0;
    return {
      tabs: this.pages.map((p) => ({ label: p.label, marked: p.stages && unsaved })),
      active: this.active,
    };
  }

  /** Opens a tab by index (loads its data). */
  async openTab(index: number): Promise<void> {
    this.active = Math.max(0, Math.min(this.pages.length - 1, index));
    await this.page.open();
  }

  /** Loads the open tab again (after a command ran). */
  reload(): Promise<void> {
    return this.page.open();
  }

  render(size: Size): FrameParts {
    const parts = this.page.render(size);
    const unsaved = this.draft.count();
    const status = parts.status ?? this.app.status();
    return {
      ...parts,
      status: unsaved ? Theme.changed('unsaved: ' + unsaved) + '   ' + status : status,
      notice: this.notice ?? parts.notice,
      keys: unsaved ? [parts.keys[0], ['ctrl+s', 'save'], ...parts.keys.slice(1)] : parts.keys,
    };
  }

  /** Writes the staged changes; the notice says what happened. */
  save(): string {
    const result = this.draft.apply();
    if (result.problems.length) return Theme.error(Theme.glyph.cross + ' Not saved: ' + result.problems.join('; '));
    if (!result.saved) return Theme.muted('Nothing to save.');
    const extra = this.afterSave(result);
    const where = result.files.some((f) => f.isProject)
      ? ' The next launch asks you to approve the project file again.'
      : ' New sandboxes use it.';
    return (
      Theme.ok(Theme.glyph.ok + ' Saved ' + result.saved + ' change' + (result.saved === 1 ? '' : 's') + '.') +
      Theme.muted(where) +
      (extra ? ' ' + extra : '')
    );
  }

  async handle(key: Key): Promise<Step<ShellExit>> {
    this.notice = undefined;
    if (key.ctrl && key.name === 's') {
      this.notice = this.draft.count() ? this.save() : Theme.muted('Nothing to save.');
      await this.page.open();
      return;
    }
    if (!this.page.capturing && !key.ctrl && !key.meta && /^[1-7]$/.test(key.text)) {
      const index = Number(key.text) - 1;
      if (index < this.pages.length && index !== this.active) await this.openTab(index);
      return;
    }
    const step = await this.page.handle(key);
    if (step && step.done.kind === 'quit') return this.leave();
    return step;
  }

  /** Leaving with unsaved changes asks what to do with them. */
  private async leave(): Promise<Step<ShellExit>> {
    const count = this.draft.count();
    if (!count) return { done: { kind: 'quit' } };
    const answer = await this.app.dialog<'save' | 'discard' | 'cancel'>({
      title: 'Unsaved changes',
      lines: ['You have ' + count + ' unsaved change' + (count === 1 ? '' : 's') + ' in Settings and Apps.'],
      choices: [
        { value: 'save', label: 'Save', key: 's' },
        { value: 'discard', label: 'Discard', key: 'd', danger: true },
        { value: 'cancel', label: 'Cancel', key: 'c' },
      ],
      escape: 'cancel',
    });
    if (answer === 'cancel') return;
    if (answer === 'discard') {
      this.draft.discard();
      return { done: { kind: 'quit' } };
    }
    this.notice = this.save();
    if (this.draft.count()) return;
    return { done: { kind: 'quit' } };
  }
}
