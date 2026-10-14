// Starts one ptyhost (the ConPTY bridge, sandbox/csharp/PtyHost.cs) per agent session and waits for it to listen.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { ensureCompiled } from '../runtime/csc.js';
import { portOpen } from '../runtime/ports.js';
import { logsDir, toolsDir } from '../runtime/paths.js';
import { session } from '../runtime/session.js';

export function ensurePtyHost(): string {
  return ensureCompiled('ptyhost');
}

/** Resolves when ptyhost listens; rejects early if it exits first (e.g. the agent could not be started). */
export async function waitForPtyHost(child: ChildProcess, port: number, timeoutMs: number): Promise<void> {
  let exitCode: number | null | undefined;
  child.once('exit', (code) => {
    exitCode = code;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitCode !== undefined) throw new Error('the session host stopped right away (exit ' + exitCode + ')');
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the session host did not start listening on port ' + port);
}

export function ptyHostLog(id: string): string {
  return path.join(logsDir, 'ptyhost-' + id + '.log');
}

/** The last lines of a session's ptyhost log (the agent's final output is written there when it exits). */
export function ptyHostLogTail(id: string, lines = 12): string {
  try {
    return fs.readFileSync(ptyHostLog(id), 'utf8').trim().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export interface PtyHostOptions {
  exe: string;
  port: number;
  token: string;
  cols: number;
  rows: number;
  command: string;
  restartCommand: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  id: string;
  remote: boolean;
}

/**
 * conpty.dll (+ OpenConsole.exe) the host downloaded, when provisioning.conpty is on; ptyhost falls back to Windows'
 * own.
 */
const conptyDll = (): string | null => {
  const dll = path.join(toolsDir, 'conpty', 'conpty.dll');
  return session.provisioning.conpty?.enabled !== false &&
    fs.existsSync(dll) &&
    fs.existsSync(path.join(toolsDir, 'conpty', 'OpenConsole.exe'))
    ? dll
    : null;
};

/** Starts ptyhost detached, so closing a terminal tab never kills the agent; only the agent exiting ends it. */
export function startPtyHost(o: PtyHostOptions): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...o.env, PTYHOST_BIND: o.remote ? 'any' : 'loopback' };
  delete env.PTYHOST_CONPTY;
  const dll = conptyDll();
  if (dll) env.PTYHOST_CONPTY = dll;
  return spawn(
    o.exe,
    [String(o.port), o.token, String(o.cols), String(o.rows), ptyHostLog(o.id), o.command, o.restartCommand],
    { cwd: o.cwd, env, detached: true, stdio: 'ignore', windowsHide: true },
  );
}
