// network.forwardPorts, PC side: http://localhost:<pc> on this PC reaches <sandbox> inside the sandbox while it runs.
// Runs in the background watcher. Listens on 127.0.0.1 only (nothing else on your network can use it), and connects
// only to an address the sandbox published that is on this PC's Hyper-V network (isSandboxAddress). Bytes are passed
// through, never looked at. No admin rights needed (no netsh portproxy).
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { relayPort, type PortForward } from '../shared/netpolicy.js';
import { readSandboxStatus, readValid, writeJsonAtomic } from '../shared/rundir.js';
import { isSandboxAddress } from './attach.js';

const Forwards = z
  .array(z.object({ pc: z.number().int().min(1).max(65535), sandbox: z.number().int().min(1).max(65535) }))
  .max(64);
const forwardsFile = (storageRoot: string, dataPath: string): string =>
  path.join(storageRoot, 'sync', path.basename(dataPath) + '-forwards.json');

/** Host-only: the forwards of the running sandbox (written at launch, read by the watcher). */
export const saveForwards = (storageRoot: string, dataPath: string, forwards: PortForward[]): void =>
  writeJsonAtomic(forwardsFile(storageRoot, dataPath), forwards);
export const readForwards = (storageRoot: string, dataPath: string): PortForward[] =>
  readValid(Forwards, forwardsFile(storageRoot, dataPath)) ?? [];

/** The sandbox's address on this PC's Hyper-V network, from its status (null until it has one). */
export const sandboxAddress = (dataPath: string): string | null =>
  readSandboxStatus(dataPath)?.addresses?.find((a: string) => isSandboxAddress(a)) ?? null;

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
