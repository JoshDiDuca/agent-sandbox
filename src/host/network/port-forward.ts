// network.forwardPorts, PC side: http://localhost:<pc> on this PC reaches <sandbox> inside the sandbox while it runs.
// Runs in the background watcher. Listens on 127.0.0.1 only (nothing else on your network can use it), and connects
// only to an address the sandbox published that is on this PC's Hyper-V network (isSandboxAddress). Bytes are passed
// through, never looked at. No admin rights needed (no netsh portproxy).
import net from 'node:net';
import { z } from 'zod';
import { relayPort, type PortForward } from '../../shared/network/index.js';
import { RunDir } from '../../shared/channel/index.js';
import { JsonFile } from '../../shared/io/index.js';
import { hostStateFile } from '../storage/index.js';
import { isSandboxAddress } from '../channel/index.js';

const Forwards = z
  .array(z.object({ pc: z.number().int().min(1).max(65535), sandbox: z.number().int().min(1).max(65535) }))
  .max(64);
const forwardsFile = (storageRoot: string, dataPath: string): JsonFile<PortForward[]> =>
  new JsonFile(Forwards, hostStateFile(storageRoot, dataPath, '-forwards.json'));

/** Host-only: the forwards of the running sandbox (written at launch, read by the watcher). */
export const saveForwards = (storageRoot: string, dataPath: string, forwards: PortForward[]): void =>
  forwardsFile(storageRoot, dataPath).write(forwards);
export const readForwards = (storageRoot: string, dataPath: string): PortForward[] =>
  forwardsFile(storageRoot, dataPath).read() ?? [];

/** The sandbox's address on this PC's Hyper-V network, from its status (null until it has one). */
export const sandboxAddress = (dataPath: string): string | null =>
  new RunDir(dataPath).readSandboxStatus()?.addresses?.find((a: string) => isSandboxAddress(a)) ?? null;

/** Starts one listener per forward; returns a function that stops them. */
export const startPortForwards = (
  forwards: PortForward[],
  address: () => string | null,
  note: (message: string) => void = () => undefined,
): (() => void) => {
  const servers = forwards.map((f, i) => {
    const server = net.createServer((client) => {
      const ip = address();
      if (!ip) {
        client.destroy();
        return;
      }
      const target = net.connect(relayPort(i), ip);
      client.pipe(target).pipe(client);
      target.on('error', () => client.destroy());
      client.on('error', () => target.destroy());
    });
    server.on('error', (e: NodeJS.ErrnoException) =>
      note(
        'localhost:' +
          f.pc +
          ' could not be forwarded' +
          (e.code === 'EADDRINUSE' ? ': something on this PC already uses that port' : ': ' + e.message),
      ),
    );
    server.listen(f.pc, '127.0.0.1', () => note('localhost:' + f.pc + ' -> sandbox port ' + f.sandbox));
    return server;
  });
  return () => servers.forEach((s) => s.close());
};
