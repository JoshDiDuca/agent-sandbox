// Guest entry point, started by bootstrap.ps1 in the sandbox window. Provisions everything, starts the session
// daemon, asks it for the first agent session and then shows that session in this window.
import fs from 'node:fs';
import path from 'node:path';
import { logsDir } from '../runtime/paths.js';
import { setSandboxStatus } from '../runtime/status.js';
import { errMsg } from '../../core/util/errors.js';
import { runBoot } from '../boot/boot.js';

runBoot().catch((e: unknown) => {
  const message = errMsg(e) + (e instanceof Error && e.stack ? '\n' + e.stack : '');
  try {
    setSandboxStatus('failed', errMsg(e));
    fs.writeFileSync(path.join(logsDir, 'guest-error.txt'), message);
  } catch {
    /* ignore */
  }
  // The window gets the plain message; the stack trace is in guest-error.txt.
  console.error(
    '\n\x1b[31mThe sandbox could not start: ' +
      errMsg(e) +
      '\x1b[0m\nDetails: ' +
      path.join(logsDir, 'guest-error.txt'),
  );
  process.exitCode = 1;
});
