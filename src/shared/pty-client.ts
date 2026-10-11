// Client side of the ptyhost protocol (see sandbox/ptyhost.cs). Used by the window inside the sandbox and by
// `--terminal` / `attach` on the host, so it only depends on Node built-ins.
import net from 'node:net';

export const FrameType = { Hello: 1, Input: 2, Resize: 3, Restart: 4, Output: 16, Exit: 17, Error: 18, Restarting: 19 } as const;

export interface Frame { type: number; payload: Buffer }
export interface Endpoint { addresses: string[]; port: number; token: string }
export type ClientResult = { reason: 'exit'; exitCode: number } | { reason: 'detach' | 'closed' } | { reason: 'error'; message: string };

/** Ctrl+] — the same detach key telnet uses; Claude Code does not bind it. */
export const DETACH_KEY = 0x1d;

export const encodeFrame = (type: number, payload: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
};

export const helloFrame = (token: string, cols: number, rows: number, controlOnly = false): Buffer => {
  const head = Buffer.alloc(5);
  head.writeInt16LE(cols, 0);
  head.writeInt16LE(rows, 2);
  head.writeUInt8(controlOnly ? 1 : 0, 4);
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

/**
 * Removes OSC 52 (clipboard write) from the sandbox's output before it reaches your terminal: an untrusted program
 * must not be able to silently put text into your clipboard. Everything else (colours, titles, links) passes.
 * Stateful, so a sequence split across chunks is still caught.
 */
export class OutputFilter {
  private carry = '';
  push(chunk: Buffer): Buffer {
    let text = (this.carry + chunk.toString('latin1')).replace(/\x1b\]52;[^\x07\x1b]*(\x07|\x1b\\)/g, '');
    this.carry = '';
    const open = text.lastIndexOf('\x1b');
    const tail = open === -1 ? '' : text.slice(open);
    if (tail.length < 1 << 16 && /^\x1b(\](5(2(;[^\x07\x1b]*)?)?)?)?$/.test(tail)) {
      this.carry = tail;
      text = text.slice(0, open);
    }
    return Buffer.from(text, 'latin1');
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
  await new Promise<void>((resolve) => socket.end(Buffer.concat([helloFrame(endpoint.token, 80, 24, true), encodeFrame(type)]), resolve));
};

/**
 * Bridges this process's terminal to the remote program until it exits, the connection drops, or the user presses
 * the detach key. Restores the terminal before resolving.
 */
export const runTerminalClient = (socket: net.Socket, token: string, options: { detachKey?: number } = {}): Promise<ClientResult> => {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const size = (): [number, number] => [stdout.columns || 120, stdout.rows || 30];
  return new Promise((resolve) => {
    let done = false;
    const reader = new FrameReader();
    const filter = new OutputFilter();
    const finish = (result: ClientResult): void => {
      if (done) return;
      done = true;
      stdin.off('data', onInput);
      stdout.off('resize', onResize);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      socket.destroy();
      stdout.write('\x1b[0m\x1b[?25h\r\n');
      resolve(result);
    };
    const onInput = (chunk: Buffer): void => {
      if (options.detachKey !== undefined && chunk.includes(options.detachKey)) { finish({ reason: 'detach' }); return; }
      socket.write(encodeFrame(FrameType.Input, chunk));
    };
    const onResize = (): void => { const [c, r] = size(); socket.write(resizeFrame(c, r)); };

    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      try { frames = reader.push(chunk); } catch { finish({ reason: 'error', message: 'invalid data from the sandbox' }); return; }
      for (const frame of frames) {
        if (frame.type === FrameType.Output) stdout.write(filter.push(frame.payload));
        else if (frame.type === FrameType.Restarting) stdout.write('\x1b[2J\x1b[3J\x1b[H');
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
    stdin.on('data', onInput);
    stdin.resume();
    stdout.on('resize', onResize);
  });
};
