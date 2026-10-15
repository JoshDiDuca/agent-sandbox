// What the menu shows about the running sandbox (the status line), kept fresh in the background. Drawing and keys only
// read the last copy: the process list is fetched without blocking (every few seconds, and after an action), and the
// screen is told when what it shows has changed. While it runs, the host's own "is the sandbox running?" questions are
// answered from the same copy, so no page waits for a child process.
import { readTasklistAsync, useTasklistCache } from '../../host/sandbox/index.js';

export interface LiveOptions {
  /** Fetches the process list (default: tasklist, run without blocking). */
  readonly fetch?: () => Promise<string>;
  /** The status line from the facts now (reads the cached process list and small files; never runs a program). */
  readonly derive: () => string;
  /** The line changed: draw again. */
  readonly onChange: () => void;
  readonly intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 2500;

export class LiveStatus {
  private tasklist: string | undefined;
  private text = '';
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private running = false;

  constructor(private readonly o: LiveOptions) {}

  /** The status line as of the last refresh. */
  line(): string {
    return this.text;
  }

  /** Reads the process list now and derives the line (one fetch at a time; a caller during one waits for it). */
  refresh(): Promise<void> {
    this.pending ??= (async () => {
      try {
        const list = await (this.o.fetch ?? readTasklistAsync)();
        // Stopped meanwhile: a command may be running, and nothing here may touch the host's facts any more.
        if (!this.running) return;
        this.tasklist = list;
        this.derive();
      } catch {
        // The line keeps what it showed; the next refresh tries again.
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }

  private derive(): void {
    const next = this.o.derive();
    if (next === this.text) return;
    this.text = next;
    if (this.running) this.o.onChange();
  }

  /** Starts keeping the line fresh and answers the host's process questions from it (until stop). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    useTasklistCache(() => this.tasklist);
    this.timer = setInterval(() => void this.refresh(), this.o.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref();
    await this.refresh();
  }

  /** Stops; the host's questions run their own programs again (a command that runs after the menu needs the truth). */
  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
    useTasklistCache(null);
    this.tasklist = undefined;
  }
}
