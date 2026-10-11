// Feedback for slow work: a spinner line on stderr (so --json and piped output stay clean). Without a terminal (pipe, CI,
// TERM=dumb) it prints one plain line instead of animating.
import { colorEnabled } from './colors.js';

const FRAMES = ['|', '/', '-', '\\'];

/** Can a line be redrawn in place? */
export const canAnimate = (env: NodeJS.ProcessEnv, isTTY: boolean): boolean => isTTY && !env.CI && env.TERM !== 'dumb';

/** "12 s", "2 min 5 s". */
export const elapsed = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
};

/**
 * Shows `message` while work runs and removes the line afterwards. The spinner only moves while the event loop is free
 * (waiting on the sandbox); for long synchronous work (measuring folders) the static line is what you see.
 */
export const working = async <T>(message: string, work: () => Promise<T> | T, enabled = true): Promise<T> => {
  if (!enabled) return work();
  const err = process.stderr;
  const start = Date.now();
  if (!canAnimate(process.env, Boolean(err.isTTY))) {
    err.write(message + '...\n');
    return work();
  }
  let frame = 0;
  const draw = (): void => { err.write('\r\x1b[2K' + (colorEnabled(process.env, true) ? '\x1b[36m' : '') + FRAMES[frame++ % FRAMES.length] + (colorEnabled(process.env, true) ? '\x1b[0m' : '') + ' ' + message + (Date.now() - start > 3000 ? ' (' + elapsed(Date.now() - start) + ')' : '')); };
  draw();
  const timer = setInterval(draw, 120);
  try { return await work(); } finally { clearInterval(timer); err.write('\r\x1b[2K'); }
};
