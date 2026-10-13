import net from 'node:net';
import {
  FrameReader,
  encodeFrame,
  FrameType,
  resizeFrame,
  PING_INTERVAL_MS,
  type Frame,
  helloFrame,
} from './protocol.js';
import { OutputFilter } from './output-filter.js';

export type ClientResult =
  { reason: 'exit'; exitCode: number } | { reason: 'detach' | 'closed' } | { reason: 'error'; message: string };

/**
 * Node on Windows reads keys through the console API, where Backspace is ^H and Ctrl+Backspace is DEL: the reverse of
 * what terminals send. ConPTY reads ^H as Ctrl+Backspace (delete a word), so swap them back.
 */
export const fixWindowsKeys = (chunk: Buffer): Buffer => {
  if (!chunk.includes(0x08) && !chunk.includes(0x7f)) return chunk;
  return Buffer.from(chunk.map((b) => (b === 0x08 ? 0x7f : b === 0x7f ? 0x08 : b)));
};

/**
 * Bridges this process's terminal to the remote program until it exits, the connection drops, or the user presses
 * the detach key. Restores the terminal before resolving.
 */
export const runTerminalClient = (
  socket: net.Socket,
  token: string,
  options: { detachKey?: number } = {},
): Promise<ClientResult> => {
  const stdin = process.stdin;
  const stdout = process.stdout;
  // getWindowSize asks the console every time; columns/rows only change when Node noticed a resize.
  const size = (): [number, number] => {
    const [c, r] = stdout.isTTY ? stdout.getWindowSize() : [0, 0];
    return [c || 120, r || 30];
  };
  const swapKeys = process.platform === 'win32' && stdin.isTTY;
  return new Promise((resolve) => {
    let done = false;
    const reader = new FrameReader();
    const filter = new OutputFilter();
    let sent = size();
    let resizeTimer: NodeJS.Timeout | undefined;
    const finish = (result: ClientResult): void => {
      if (done) return;
      done = true;
      stdin.off('data', onInput);
      stdout.off('resize', onResize);
      clearTimeout(resizeTimer);
      clearInterval(heartbeat);
      clearInterval(sizeWatch);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      socket.destroy();
      stdout.write('\x1b[0m\x1b[?25h\r\n');
      resolve(result);
    };
    const onInput = (chunk: Buffer): void => {
      if (options.detachKey !== undefined && chunk.includes(options.detachKey)) {
        finish({ reason: 'detach' });
        return;
      }
      socket.write(encodeFrame(FrameType.Input, swapKeys ? fixWindowsKeys(chunk) : chunk));
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
    const onResize = (): void => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        sendSize();
      }, 120);
    };
    const heartbeat = setInterval(() => socket.write(encodeFrame(FrameType.Ping)), PING_INTERVAL_MS);
    // Windows does not always report a resize in raw mode, so the size is also checked twice a second.
    const sizeWatch = setInterval(() => {
      if (!resizeTimer) sendSize();
    }, 500);

    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = reader.push(chunk);
      } catch {
        finish({ reason: 'error', message: 'invalid data from the sandbox' });
        return;
      }
      for (const frame of frames) {
        if (frame.type === FrameType.Output) stdout.write(filter.push(frame.payload));
        else if (frame.type === FrameType.Console) passthrough = frame.payload.toString('latin1') === 'conpty.dll';
        else if (frame.type === FrameType.Restarting) stdout.write('\x1b[2J\x1b[3J\x1b[H');
        else if (frame.type === FrameType.Exit)
          finish({ reason: 'exit', exitCode: frame.payload.length >= 4 ? frame.payload.readInt32LE(0) : 1 });
        else if (frame.type === FrameType.Error)
          finish({
            reason: 'error',
            message: frame.payload
              .toString('utf8')
              .slice(0, 500)
              .replace(/[\x00-\x1f\x7f]/g, ' '),
          });
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
