// Keeps escape sequences typed into your terminal whole, so ConPTY never sees half of one.

/** How long an unfinished escape sequence is held back waiting for the rest (a lone Esc key press waits this long). */
export const JOIN_MS = 30;
/** Longest sequence held back; anything longer is not a key, mouse report or terminal reply, and is sent as it is. */
const MAX_HELD = 64;

/**
 * Keeps each escape sequence typed into your terminal (keys, mouse reports, the terminal's replies) in one INPUT frame.
 * The console can hand one over in pieces; ConPTY reads a lone "ESC[" as Alt+[ and the rest as typed text, so a split
 * Right arrow (ESC[C) left a stray "C" in the agent's prompt. An unfinished sequence at the end of a chunk is held
 * until the rest arrives (or JOIN_MS passes).
 */
export class InputJoiner {
  private held: Buffer = Buffer.alloc(0);

  /** The bytes to send now; an unfinished sequence at the end is kept for the next chunk. */
  push(chunk: Buffer): Buffer {
    const data = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
    const cut = unfinishedSequence(data);
    this.held = Buffer.from(data.subarray(cut));
    return data.subarray(0, cut);
  }

  holding(): boolean {
    return this.held.length > 0;
  }

  flush(): Buffer {
    const out = this.held;
    this.held = Buffer.alloc(0);
    return out;
  }
}

/** Where an escape sequence that has not ended yet starts at the end of `data` (data.length if there is none). */
function unfinishedSequence(data: Buffer): number {
  const start = data.lastIndexOf(0x1b, -1);
  if (start === -1 || data.length - start > MAX_HELD) return data.length;
  const rest = data.subarray(start + 1);
  if (rest.length === 0) return start;
  // ESC [ or ESC O (SS3) followed only by parameter / intermediate bytes: the final byte has not arrived yet.
  if (rest[0] === 0x5b || rest[0] === 0x4f)
    return rest.subarray(1).every((b) => b >= 0x20 && b <= 0x3f) && (rest[0] === 0x5b || rest.length === 1)
      ? start
      : data.length;
  return data.length;
}
