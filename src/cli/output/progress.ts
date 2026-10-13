// Feedback for slow work: a spinner line on stderr (so --json and piped output stay clean). Without a terminal (pipe,
// CI, TERM=dumb) it prints one plain line instead of animating.
import { colorEnabled, shorten, termWidth } from './colors.js';

const FRAMES = ['|', '/', '-', '\\'];

/** Can a line be redrawn in place? */
export function canAnimate(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  return isTTY && !env.CI && env.TERM !== 'dumb';
}

/** "12 s", "2 min 5 s". */
export function elapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
}

/** One line of progress: `line` is shown, `key` changes when it is worth a new plain line, `what` names what runs. */
export interface Progressing {
  line: string;
  key: string;
  what: string;
}

/**
 * Follows long work (a sandbox's boot): on a terminal one line redrawn in place with the time so far; without one a
 * plain line each time `key` changes. When nothing changes for `stallMs` it says so (stall(what, ms)). A failure first
 * prints where it stopped, then rethrows.
 */
export async function follow<T>(
  show: () => Progressing,
  work: () => Promise<T>,
  o: { stallMs?: number; stall: (what: string, ms: number) => string },
): Promise<T> {
  const err = process.stderr;
  const animate = canAnimate(process.env, Boolean(err.isTTY));
  const colour = colorEnabled(process.env, true);
  const start = Date.now();
  const stallMs = o.stallMs ?? 3 * 60 * 1000;
  let shown = show();
  let lastKey = '';
  let changedAt = start;
  let noticedAt = start;
  let frame = 0;
  const clear = (): void => {
    if (animate) err.write('\r\x1b[2K');
  };
  const tick = (): void => {
    const now = show();
    if (now.line !== shown.line) changedAt = noticedAt = Date.now();
    shown = now;
    if (Date.now() - noticedAt >= stallMs) {
      clear();
      err.write(o.stall(shown.what, Date.now() - changedAt) + '\n');
      noticedAt = Date.now();
    }
    const time = Date.now() - start > 3000 ? ' (' + elapsed(Date.now() - start) + ')' : '';
    if (animate) {
      err.write(
        '\r\x1b[2K' +
          (colour ? '\x1b[36m' : '') +
          FRAMES[frame++ % FRAMES.length] +
          (colour ? '\x1b[0m' : '') +
          ' ' +
          shorten(shown.line, termWidth() - 4 - time.length) +
          time,
      );
    } else if (shown.key !== lastKey) {
      lastKey = shown.key;
      err.write(shown.line + time + '\n');
    }
  };
  tick();
  const timer = setInterval(tick, animate ? 150 : 1000);
  try {
    return await work();
  } catch (e) {
    clear();
    err.write('It stopped at: ' + shown.line + '\n');
    throw e;
  } finally {
    clearInterval(timer);
    clear();
  }
}

/**
 * Shows `message` while work runs and removes the line afterwards. The spinner only moves while the event loop is free
 * (waiting on the sandbox); for long synchronous work (measuring folders) the static line is what you see.
 */
export async function working<T>(
  message: string | (() => string),
  work: () => Promise<T> | T,
  enabled = true,
): Promise<T> {
  if (!enabled) return work();
  const err = process.stderr;
  const start = Date.now();
  // A function: the message follows the work (e.g. the sandbox's boot step); without a terminal each new one is a line.
  const text = (): string => (typeof message === 'function' ? message() : message);
  if (!canAnimate(process.env, Boolean(err.isTTY))) {
    let last = text();
    err.write(last + '...\n');
    const follow =
      typeof message === 'function'
        ? setInterval(() => {
            const now = text();
            if (now !== last) {
              last = now;
              err.write(now + '\n');
            }
          }, 500)
        : null;
    try {
      return await work();
    } finally {
      if (follow) clearInterval(follow);
    }
  }
  let frame = 0;
  const draw = (): void => {
    err.write(
      '\r\x1b[2K' +
        (colorEnabled(process.env, true) ? '\x1b[36m' : '') +
        FRAMES[frame++ % FRAMES.length] +
        (colorEnabled(process.env, true) ? '\x1b[0m' : '') +
        ' ' +
        shorten(text(), termWidth() - 14) +
        (Date.now() - start > 3000 ? ' (' + elapsed(Date.now() - start) + ')' : ''),
    );
  };
  draw();
  const timer = setInterval(draw, 120);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    err.write('\r\x1b[2K');
  }
}
