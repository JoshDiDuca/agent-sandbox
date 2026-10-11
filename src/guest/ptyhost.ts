// Starts one ptyhost (the ConPTY bridge, sandbox/ptyhost.cs) per agent session and waits for it to listen.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { ensureCompiled } from './helpers.js';
import { portOpen } from './ports.js';
import { logsDir } from './env.js';

export const ensurePtyHost = (): string => ensureCompiled('ptyhost');

/** Resolves when ptyhost listens; rejects early if it exits first (e.g. the agent could not be started). */
export const waitForPtyHost = async (child: ChildProcess, port: number, timeoutMs: number): Promise<void> => {
  let exitCode: number | null | undefined;
  child.once('exit', (code) => { exitCode = code; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitCode !== undefined) throw new Error('the session host stopped right away (exit ' + exitCode + ')');
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the session host did not start listening on port ' + port);
};

export const ptyHostLog = (id: string): string => path.join(logsDir, 'ptyhost-' + id + '.log');

/** The last lines of a session's ptyhost log (the agent's final output is written there when it exits). */
export const ptyHostLogTail = (id: string, lines = 12): string => {
  try { return fs.readFileSync(ptyHostLog(id), 'utf8').trim().split(/\r?\n/).slice(-lines).join('\n'); } catch { return ''; }
};

export interface PtyHostOptions { exe: string; port: number; token: string; cols: number; rows: number; command: string; restartCommand: string; cwd: string; env: NodeJS.ProcessEnv; id: string; remote: boolean }

/** Starts ptyhost detached, so closing a terminal tab never kills the agent; only the agent exiting ends it. */
export const startPtyHost = (o: PtyHostOptions): ChildProcess =>
  spawn(o.exe, [String(o.port), o.token, String(o.cols), String(o.rows), ptyHostLog(o.id), o.command, o.restartCommand], {
    cwd: o.cwd, env: { ...o.env, PTYHOST_BIND: o.remote ? 'any' : 'loopback' }, detached: true, stdio: 'ignore', windowsHide: true,
  });
