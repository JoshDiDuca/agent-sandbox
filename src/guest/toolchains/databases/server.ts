// What every database module shares: where data lives, starting a server detached, and safe first-time creation.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { safeRemove } from '../../../shared/safe-remove.js';
import { dataDir, exists, logsDir, mkdirp } from '../../env.js';
import { portOpen, waitForPort } from '../../ports.js';

/** C:\AgentData\databases\<name>: the data survives the sandbox. */
export const dataFor = (name: string): string => path.join(dataDir, 'databases', name);

/** Starts a server detached (it outlives the boot script) with its output in logs\<name>.log, and waits for its port. */
export const startServer = async (name: string, exe: string, args: string[], port: number): Promise<void> => {
  if (await portOpen(port)) throw new Error('port ' + port + ' is already in use (change databases.' + name + '.port)');
  const logFile = path.join(logsDir, name + '.log');
  const out = fs.openSync(logFile, 'a');
  spawn(exe, args, { detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
  fs.closeSync(out);
  if (!(await waitForPort(port, 60)))
    throw new Error(name + ' did not start listening on port ' + port + '; see ' + logFile);
};

/**
 * Lock files a sandbox that was closed without shutting the server down leaves behind. Only when nothing listens on
 * the port: a server already running in this VM keeps its lock.
 */
export const clearStaleLocks = async (dir: string, files: string[], port: number): Promise<void> => {
  if (await portOpen(port)) return;
  for (const f of files) fs.rmSync(path.join(dir, f), { force: true });
};

/**
 * Creates a database folder with `create` (initdb, install-db) unless `marker` is there. A failed or interrupted run
 * removes the folder again when this call made it, so the half-made one is not taken for a finished database next boot.
 */
export const createOnce = async (data: string, marker: string, create: () => Promise<void>): Promise<void> => {
  if (exists(path.join(data, marker))) return;
  const existed = exists(data);
  mkdirp(path.dirname(data));
  try {
    await create();
  } catch (e) {
    if (!existed) {
      try {
        safeRemove(data, dataDir);
      } catch {
        /* the original error is the one to report */
      }
    }
    throw e;
  }
};
