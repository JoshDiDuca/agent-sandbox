// The common shape of a tab that is a list: it loads its data, builds a list screen from it, and acts on what the list
// returns. After every action the list is built again from fresh data, on the same entry.
import { ListScreen, type App, type FrameParts, type Key, type ListOptions, type ListResult } from '../../tui/index.js';
import type { Size, Step } from '../../tui/index.js';
import type { Page, ShellExit } from '../shell.js';

/** What an action did: leave the shell, and/or what the rebuilt list shows. */
export interface Outcome<T> {
  readonly exit?: ShellExit;
  /** Keep the cursor on this entry (default: the one that was acted on). */
  readonly focus?: T;
  readonly notice?: string;
  /** Load the data again before rebuilding. */
  readonly reload?: boolean;
}

export abstract class ListPage<T> implements Page {
  abstract readonly label: string;
  readonly stages: boolean = false;
  private list: ListScreen<T> | undefined;
  private notice: string | undefined;

  constructor(protected readonly app: App) {}

  /** Loads the data the list shows (called when the tab opens and after actions that change it). */
  protected abstract load(): Promise<void>;
  /** The list for the data loaded (pure: no I/O). */
  protected abstract options(): ListOptions<T>;
  /** Does what the list returned. */
  protected abstract act(result: ListResult<T>): Promise<Outcome<T>>;

  get capturing(): boolean {
    return this.list?.isSearching ?? false;
  }

  /** The id of the open sidebar category, if the list has one. */
  protected get category(): string | undefined {
    return this.list?.currentCategory;
  }

  /** The entries ticked in a multi-select list. */
  protected ticked(): T[] {
    return this.list?.ticked() ?? [];
  }

  async open(): Promise<void> {
    await this.load();
    this.rebuild(undefined);
  }

  /** Builds the list again, on `focus` when it is still there. */
  protected rebuild(focus: T | undefined, notice?: string): void {
    const startCategory = this.list?.currentCategory;
    this.list = new ListScreen<T>({ ...this.options(), startAt: focus, startCategory, notice: notice ?? this.notice });
    this.notice = undefined;
  }

  /** Shows `text` now, before slow work starts. */
  protected busy(text: string, focus?: T): void {
    this.rebuild(focus, text);
    this.app.redraw();
  }

  /** Shows a notice on the next draw. */
  protected say(text: string | undefined): void {
    this.notice = text;
  }

  render(size: Size): FrameParts {
    this.list ??= new ListScreen<T>(this.options());
    return this.list.render(size);
  }

  async handle(key: Key): Promise<Step<ShellExit>> {
    this.list ??= new ListScreen<T>(this.options());
    const step = this.list.handle(key);
    if (!step) return this.afterKey();
    const result = step.done;
    const outcome = result.kind === 'back' ? { exit: { kind: 'quit' } as ShellExit } : await this.act(result);
    if (outcome.exit) return { done: outcome.exit };
    if (outcome.reload) await this.load();
    const here = result.kind === 'pick' || result.kind === 'action' ? result.value : undefined;
    this.rebuild(outcome.focus ?? here, outcome.notice);
    return;
  }

  /** A key that did not finish the list was handled (the cursor moved, a search began ...). */
  protected afterKey(): Promise<Step<ShellExit>> | Step<ShellExit> {
    return;
  }
}
