// Local TCP port helpers shared by the session host (ptyhost) and the databases.
import net from 'node:net';

/** A free port on loopback: finding one must not count as "node listens on the network" (that raises firewall prompts). */
export const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
});

/** Whether something accepts connections on 127.0.0.1:port. */
export const portOpen = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

/** Polls until the port accepts connections; false when `seconds` pass first. */
export const waitForPort = async (port: number, seconds: number): Promise<boolean> => {
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};
