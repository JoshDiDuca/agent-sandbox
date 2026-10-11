// A terminal tab inside the sandbox that shows one agent session (same pseudo console the host can attach to).
// Usage: node view.js <sessionId>
import { connect, runTerminalClient } from '../shared/pty-client.js';
import { readSession } from '../shared/rundir.js';
import { dataDir } from './env.js';

export const viewSession = async (id: string): Promise<number> => {
  const session = readSession(dataDir, id);
  if (!session?.attach) { console.error('Session ' + id + ' is not running.'); return 1; }
  const socket = await connect({ ...session.attach, addresses: ['127.0.0.1'] });
  const result = await runTerminalClient(socket, session.attach.token);
  if (result.reason === 'exit') console.log(session.harness + ' exited with code ' + result.exitCode + '.');
  else if (result.reason === 'error') console.log('Session error: ' + result.message);
  return result.reason === 'exit' ? result.exitCode : 1;
};

if (process.argv[1]?.endsWith('view.js') && process.argv[2]) {
  viewSession(process.argv[2]).then((code) => { process.exitCode = code; }, (e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
}
