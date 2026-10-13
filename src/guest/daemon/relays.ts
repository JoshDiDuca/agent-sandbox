// network.forwardPorts, sandbox side: one relay per forward, listening on its relay port (reachable only from the
// sandbox's own subnet, i.e. the PC: see the firewall rule in setup/network.ts) and passing each connection on to
// localhost:<sandbox port>. So a dev server that only listens on localhost is reachable from the PC too.
import net from 'node:net';
import { relayPort } from '../../shared/network/policy.js';
import { log, warn } from '../runtime/log.js';
import { session } from '../runtime/session.js';
import { errMsg } from '../../core/util/errors.js';

export function startRelays(): void {
  (session.network.forwardPorts ?? []).forEach((f, i) => {
    const server = net.createServer((client) => {
      const target = net.connect(f.sandbox, '127.0.0.1');
      client.pipe(target).pipe(client);
      target.on('error', () => client.destroy());
      client.on('error', () => target.destroy());
    });
    server.on('error', (e) => warn('Port forward ' + f.pc + ' -> ' + f.sandbox + ' could not start: ' + errMsg(e)));
    server.listen(relayPort(i), '0.0.0.0', () =>
      log("Port forward: the PC's localhost:" + f.pc + ' reaches localhost:' + f.sandbox + ' here.'),
    );
  });
}
