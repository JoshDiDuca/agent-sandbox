// ANSI colours for terminal output (one place, so menus, errors and warnings agree).
// Colour is on only for a terminal that wants it: not with NO_COLOR, TERM=dumb or piped output; FORCE_COLOR turns it
// on.

/** The colour policy as a pure function (tested); `isTTY` is that of the stream being written to. */
export function colorEnabled(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '')
    return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  return isTTY && env.TERM !== 'dumb';
}

const paint =
  (code: number) =>
  (text: string): string =>
    colorEnabled(process.env, Boolean(process.stdout.isTTY)) ? '\x1b[' + code + 'm' + text + '\x1b[0m' : text;

export const c = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  cyan: paint(36),
};

/** Removes colour codes (for measuring or comparing text). */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Cuts `text` to `max` visible characters, ending in an ellipsis (plain text only). */
export function shorten(text: string, max: number): string {
  return max < 2 || text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** Cuts the middle out of a long path or id so both ends stay readable. */
export function shortenMiddle(text: string, max: number): string {
  if (max < 5 || text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return text.slice(0, head) + '…' + text.slice(text.length - (keep - head));
}

/** 1536 -> "1.5 KB" is in the data command; this is "3 min ago" for the tables. */
export function ago(then: number | string | Date, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - new Date(then).getTime()) / 1000));
  if (secs < 45) return 'just now';
  if (secs < 3600) return Math.round(secs / 60) + ' min ago';
  if (secs < 86400) return Math.round(secs / 3600) + ' h ago';
  return Math.round(secs / 86400) + ' d ago';
}

/** Width to lay text out in (terminal columns, 80 when unknown, never absurdly small). */
export function termWidth(): number {
  return Math.max(40, process.stdout.columns ?? 80);
}

/** Each menu page starts on a clean screen (answered prompts would otherwise pile up above it). */
export function clearScreen(): void {
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

/** Rows of a list that fit the terminal (leaving room for the prompt and the help line). */
export function pageSizeFor(wanted: number): number {
  return Math.max(5, Math.min(wanted, (process.stdout.rows ?? 30) - 6));
}
