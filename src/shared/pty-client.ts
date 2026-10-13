// Client side of the ptyhost protocol (see sandbox/ptyhost.cs). Used by the window inside the sandbox and by
// `--terminal` / `attach` on the host, so it only depends on Node built-ins.
import net from 'node:net';
import { enableVtInput } from './console-input.js';

export const FrameType = { Hello: 1, Input: 2, Resize: 3, Restart: 4, Ping: 5, Output: 16, Exit: 17, Error: 18, Restarting: 19, Status: 20, Console: 21 } as const;

/** HELLO flags: control-only connections get no output and never size the console; a query only asks for STATUS. */
export const HelloFlag = { ControlOnly: 1, Query: 2 } as const;

/** Viewers ping this often; ptyhost counts a viewer as gone after 15 s of silence (e.g. its terminal tab was closed). */
export const PING_INTERVAL_MS = 5000;

export interface Frame { type: number; payload: Buffer }
export interface Endpoint { addresses: string[]; port: number; token: string }
export type ClientResult = { reason: 'exit'; exitCode: number } | { reason: 'detach' | 'closed' } | { reason: 'error'; message: string };

/** Turns off every mouse tracking mode a program may have turned on in your terminal (normal, button, any, UTF-8, SGR, urxvt). */
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l';

/** Ctrl+] — the same detach key telnet uses; Claude Code does not bind it. */
export const DETACH_KEY = 0x1d;

export const encodeFrame = (type: number, payload: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
};

export const helloFrame = (token: string, cols: number, rows: number, flags = 0): Buffer => {
  const head = Buffer.alloc(5);
  head.writeInt16LE(cols, 0);
  head.writeInt16LE(rows, 2);
  head.writeUInt8(flags, 4);
  return encodeFrame(FrameType.Hello, Buffer.concat([head, Buffer.from(token, 'utf8')]));
};

export const resizeFrame = (cols: number, rows: number): Buffer => {
  const payload = Buffer.alloc(4);
  payload.writeInt16LE(cols, 0);
  payload.writeInt16LE(rows, 2);
  return encodeFrame(FrameType.Resize, payload);
};

/** Same limit as ptyhost.cs; a peer announcing more is broken or hostile. */
export const MAX_FRAME_BYTES = 1 << 20;

/** Splits a TCP byte stream back into frames. */
export class FrameReader {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): Frame[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Frame[] = [];
    while (this.pending.length >= 5) {
      const length = this.pending.readUInt32LE(1);
      if (length > MAX_FRAME_BYTES) throw new Error('frame too large (' + length + ' bytes)');
      if (this.pending.length < 5 + length) break;
      frames.push({ type: this.pending[0], payload: this.pending.subarray(5, 5 + length) });
      this.pending = this.pending.subarray(5 + length);
    }
    return frames;
  }
}

/** OSC commands that may reach your terminal: window title (0, 1, 2), links (8), progress (9;4), shell marks (133). */
const KEPT_OSC = (body: string): boolean => {
  const number = /^(\d{1,4})(;|$)/.exec(body);
  if (!number) return false;
  const n = Number(number[1]);
  return n <= 2 || n === 8 || n === 133 || (n === 9 && body.startsWith(number[1] + ';4;'));
};
/** Longest OSC kept (a title or a link); anything longer is dropped whole. */
const MAX_KEPT_STRING = 4096;

/**
 * Removes the terminal "strings" an untrusted program could abuse from the sandbox's output before it reaches your
 * terminal: clipboard writes (OSC 52), terminal macros (ConEmu's OSC 9), DCS / APC / PM / SOS, and their C1 forms.
 * Titles, links, progress and colours pass. A byte-level state machine, so no split across chunks, leading zero
 * (ESC]052) or huge payload slips through: a dropped string stays dropped until its terminator, however long it is.
 */
export class OutputFilter {
  /** text: normal output; esc: after ESC; c2: after a 0xC2 lead byte; string: inside an OSC/DCS/...; stringEsc / stringC2: a possible terminator inside one. */
  private state: 'text' | 'esc' | 'c2' | 'string' | 'stringEsc' | 'stringC2' = 'text';
  /** The string being read: an OSC worth keeping is collected until its terminator; null = being dropped. */
  private body: number[] | null = null;

  push(chunk: Buffer): Buffer {
    const out = Buffer.allocUnsafe(chunk.length + MAX_KEPT_STRING + 8);
    let n = 0;
    const put = (...bytes: number[]): void => { for (const b of bytes) out[n++] = b; };
    /** After ESC (or the C1 form): ] opens an OSC (maybe kept), P X ^ _ open DCS / SOS / PM / APC (dropped). */
    const opens = (b: number, c1: boolean): boolean => {
      if (b === (c1 ? 0x9d : 0x5d)) { this.body = c1 ? null : []; this.state = 'string'; return true; }
      if ((c1 ? [0x90, 0x98, 0x9e, 0x9f] : [0x50, 0x58, 0x5e, 0x5f]).includes(b)) { this.body = null; this.state = 'string'; return true; }
      return false;
    };
    const endString = (terminator: number[]): void => {
      const body = this.body && Buffer.from(this.body).toString('latin1');
      if (body !== null && KEPT_OSC(body)) { put(0x1b, 0x5d); out.write(body, n, 'latin1'); n += body.length; put(...terminator); }
      this.body = null;
      this.state = 'text';
    };
    const collect = (b: number): void => { if (this.body && this.body.push(b) > MAX_KEPT_STRING) this.body = null; };
    for (const b of chunk) {
      switch (this.state) {
        case 'text':
          if (b === 0x1b) this.state = 'esc';
          else if (b === 0xc2) this.state = 'c2';
          else put(b);
          break;
        case 'esc':
          if (opens(b, false)) break;
          if (b !== 0x1b) { put(0x1b, b); this.state = 'text'; } else put(0x1b);
          break;
        case 'c2':
          if (opens(b, true)) break;
          if (b === 0x1b) { put(0xc2); this.state = 'esc'; } else if (b === 0xc2) put(0xc2); else { put(0xc2, b); this.state = 'text'; }
          break;
        case 'string':
          if (b === 0x07) endString([0x07]);
          else if (b === 0x1b) this.state = 'stringEsc';
          else if (b === 0xc2) this.state = 'stringC2';
          else if (b === 0x18 || b === 0x1a) { this.body = null; this.state = 'text'; }
          else collect(b);
          break;
        case 'stringC2':
          // U+009C is the C1 string terminator; any other character is part of the string.
          if (b === 0x9c) endString([0x1b, 0x5c]);
          else { collect(0xc2); this.state = 'string'; if (b === 0x07) endString([0x07]); else if (b === 0x1b) this.state = 'stringEsc'; else if (b !== 0xc2) collect(b); else this.state = 'stringC2'; }
          break;
        case 'stringEsc':
          if (b === 0x5c) { endString([0x1b, 0x5c]); break; }
          // ESC inside a string ends it (dropped) and starts a new sequence.
          this.body = null;
          this.state = 'esc';
          if (!opens(b, false) && b !== 0x1b) { put(0x1b, b); this.state = 'text'; }
          break;
      }
    }
    return out.subarray(0, n);
  }
}

const connectOnce = (host: string, port: number, timeoutMs: number): Promise<net.Socket> => {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timed out connecting to ' + host + ':' + port)); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.setNoDelay(true); resolve(socket); });
    socket.once('error', (e: Error) => { clearTimeout(timer); reject(e); });
  });
};

/** Tries every address the sandbox published and returns the first one that answers. */
export const connect = async (endpoint: Endpoint, timeoutMs = 3000): Promise<net.Socket> => {
  const errors: string[] = [];
  for (const address of endpoint.addresses) {
    try { return await connectOnce(address, endpoint.port, timeoutMs); } catch (e) { errors.push(address + ': ' + (e instanceof Error ? e.message : String(e))); }
  }
  throw new Error('Could not reach the sandbox session (' + errors.join('; ') + ')');
};

/** Sends one control frame (e.g. RESTART) without taking over the screen. */
export const sendControl = async (endpoint: Endpoint, type: number): Promise<void> => {
  const socket = await connect(endpoint);
  await new Promise<void>((resolve) => socket.end(Buffer.concat([helloFrame(endpoint.token, 80, 24, HelloFlag.ControlOnly), encodeFrame(type)]), resolve));
};

/** Who is watching a session right now: `remote` counts viewers on the PC (not the sandbox's own tabs). */
export interface Viewers { viewers: number; remote: number }

/**
 * Asks a session's ptyhost who is attached. Only viewers heard from in the last few seconds count, so a terminal that
 * was closed (or a PC that went to sleep) is not reported. null when the session does not answer: an older ptyhost
 * treats the query as a silent control connection, so the caller must not assume anything.
 */
export const queryViewers = async (endpoint: Endpoint, timeoutMs = 2000): Promise<Viewers | null> => {
  let socket: net.Socket;
  try { socket = await connect(endpoint, timeoutMs); } catch { return null; }
  return new Promise((resolve) => {
    const reader = new FrameReader();
    const done = (value: Viewers | null): void => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      try { frames = reader.push(chunk); } catch { done(null); return; }
      const status = frames.find((f) => f.type === FrameType.Status && f.payload.length >= 4);
      if (status) done({ viewers: status.payload.readInt16LE(0), remote: status.payload.readInt16LE(2) });
      else if (frames.some((f) => f.type === FrameType.Error)) done(null);
    });
    socket.on('error', () => done(null));
    socket.on('close', () => done(null));
    socket.write(helloFrame(endpoint.token, 80, 24, HelloFlag.Query));
  });
};

/**
 * Node on Windows reads keys through the console API, where Backspace is ^H and Ctrl+Backspace is DEL: the reverse of
 * what terminals send. ConPTY reads ^H as Ctrl+Backspace (delete a word), so swap them back.
 */
export const fixWindowsKeys = (chunk: Buffer): Buffer => {
  if (!chunk.includes(0x08) && !chunk.includes(0x7f)) return chunk;
  return Buffer.from(chunk.map((b) => (b === 0x08 ? 0x7f : b === 0x7f ? 0x08 : b)));
};

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
  holding(): boolean { return this.held.length > 0; }
  flush(): Buffer { const out = this.held; this.held = Buffer.alloc(0); return out; }
}

/** Where an escape sequence that has not ended yet starts at the end of `data` (data.length if there is none). */
const unfinishedSequence = (data: Buffer): number => {
  const start = data.lastIndexOf(0x1b, -1);
  if (start === -1 || data.length - start > MAX_HELD) return data.length;
  const rest = data.subarray(start + 1);
  if (rest.length === 0) return start;
  // ESC [ or ESC O (SS3) followed only by parameter / intermediate bytes: the final byte has not arrived yet.
  if (rest[0] === 0x5b || rest[0] === 0x4f) return rest.subarray(1).every((b) => b >= 0x20 && b <= 0x3f) && (rest[0] === 0x5b || rest.length === 1) ? start : data.length;
  return data.length;
};

/**
 * Bridges this process's terminal to the remote program until it exits, the connection drops, or the user presses
 * the detach key. Restores the terminal before resolving.
 */
export const runTerminalClient = (socket: net.Socket, token: string, options: { detachKey?: number } = {}): Promise<ClientResult> => {
  const stdin = process.stdin;
  const stdout = process.stdout;
  // getWindowSize asks the console every time; columns/rows only change when Node noticed a resize.
  const size = (): [number, number] => { const [c, r] = stdout.isTTY ? stdout.getWindowSize() : [0, 0]; return [c || 120, r || 30]; };
  // Until the console passes the terminal's input through as it is (enableVtInput), Node turns Backspace into ^H.
  let swapKeys = process.platform === 'win32' && stdin.isTTY;
  return new Promise((resolve) => {
    let done = false;
    const reader = new FrameReader();
    const filter = new OutputFilter();
    let sent = size();
    let resizeTimer: NodeJS.Timeout | undefined;
    let vtInput: ReturnType<typeof enableVtInput> | undefined;
    const finish = (result: ClientResult): void => {
      if (done) return;
      done = true;
      stdin.off('data', onInput);
      stdout.off('resize', onResize);
      clearTimeout(resizeTimer);
      clearInterval(heartbeat);
      clearInterval(sizeWatch);
      clearTimeout(joinTimer);
      socket.destroy();
      // The agent's mouse tracking ends with it: your terminal's wheel scrolls again (and clicks select text).
      stdout.write('\x1b[0m\x1b[?25h' + MOUSE_OFF + '\r\n');
      // Wait for a console-mode change still in progress, then give the console back in its normal mode.
      void (vtInput?.stop() ?? Promise.resolve()).then(() => {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
        resolve(result);
      });
    };
    const joiner = new InputJoiner();
    let joinTimer: NodeJS.Timeout | undefined;
    const sendInput = (data: Buffer): void => { if (data.length && !done) socket.write(encodeFrame(FrameType.Input, swapKeys ? fixWindowsKeys(data) : data)); };
    const onInput = (chunk: Buffer): void => {
      if (options.detachKey !== undefined && chunk.includes(options.detachKey)) { finish({ reason: 'detach' }); return; }
      clearTimeout(joinTimer);
      sendInput(joiner.push(chunk));
      // A lone Esc key press is a "sequence" that never completes: send it after a moment.
      if (joiner.holding()) joinTimer = setTimeout(() => sendInput(joiner.flush()), JOIN_MS);
    };
    // Windows' own ConPTY repaints the whole screen on every resize; dragging a window edge fires dozens of them, and
    // repaints racing each other left the screen garbled. Wait until the size settles, clear what this terminal
    // reflowed on its own, then let ptyhost repaint everything once at the new size. With conpty.dll (passthrough)
    // nothing is repainted: this terminal's own reflow and scrollback stay, and the program redraws what it needs.
    let passthrough = false;
    const sendSize = (): void => {
      const [c, r] = size();
      if (c === sent[0] && r === sent[1]) return;
      sent = [c, r];
      if (!passthrough) stdout.write('\x1b[H\x1b[J');
      socket.write(resizeFrame(c, r));
    };
    const onResize = (): void => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { resizeTimer = undefined; sendSize(); }, 120); };
    const heartbeat = setInterval(() => socket.write(encodeFrame(FrameType.Ping)), PING_INTERVAL_MS);
    // Windows does not always report a resize in raw mode, so the size is also checked twice a second.
    const sizeWatch = setInterval(() => { if (!resizeTimer) sendSize(); }, 500);

    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      try { frames = reader.push(chunk); } catch { finish({ reason: 'error', message: 'invalid data from the sandbox' }); return; }
      for (const frame of frames) {
        if (frame.type === FrameType.Output) stdout.write(filter.push(frame.payload));
        else if (frame.type === FrameType.Console) passthrough = frame.payload.toString('latin1') === 'conpty.dll';
        else if (frame.type === FrameType.Restarting) stdout.write(MOUSE_OFF + '\x1b[2J\x1b[3J\x1b[H');
        else if (frame.type === FrameType.Exit) finish({ reason: 'exit', exitCode: frame.payload.length >= 4 ? frame.payload.readInt32LE(0) : 1 });
        else if (frame.type === FrameType.Error) finish({ reason: 'error', message: frame.payload.toString('utf8').slice(0, 500).replace(/[\x00-\x1f\x7f]/g, ' ') });
      }
    });
    socket.on('close', () => finish({ reason: 'closed' }));
    socket.on('error', () => finish({ reason: 'closed' }));

    const [c, r] = size();
    stdout.write('\x1b[2J\x1b[3J\x1b[H');
    socket.write(helloFrame(token, c, r));
    if (stdin.isTTY) stdin.setRawMode(true);
    // After setRawMode (which sets the console mode): mouse reports, focus and keys then arrive as the terminal sent them.
    vtInput = enableVtInput();
    void vtInput.ready.then((on) => { if (on) swapKeys = false; });
    stdin.on('data', onInput);
    stdin.resume();
    stdout.on('resize', onResize);
  });
};
