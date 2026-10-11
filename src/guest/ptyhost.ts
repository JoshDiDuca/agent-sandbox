// Builds the sandbox's small C# helpers (ptyhost.cs, gitshim.cs) with the .NET Framework compiler that ships with
// Windows, and starts one ptyhost per agent session.
//
// The helpers are compiled onto the sandbox's own disk (wiped on close) on every boot, never cached in persistent
// storage: a tampered ptyhost.exe there would survive the wipe and see every keystroke typed from this PC.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { exists, launchDir, logsDir, mkdirp, toolsDir } from './env.js';

const CSC = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

const quoted = (arg: string): string => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
export const quoteArg = (arg: string): string => (arg !== '' && !/[\s"]/.test(arg) ? arg : quoted(arg));

/**
 * Arguments on a `cmd /d /c <agent>.cmd ...` line (npm agents). cmd parses them twice: the /c line, then the .cmd's %*.
 * & | < > ^ are literal inside quotes, so arguments with them are quoted (https://x?a=1&b=2 survives). % expands even
 * inside quotes, so each one sits between quoted pieces ("50"%" off"): every %name% cmd could see then starts with a
 * quote, and no variable is called that. cmd's quote state runs across the whole line (an embedded \" toggles it too),
 * so a metacharacter it would see outside quotes gets ^^^ (one caret left after each parse). Arguments without any
 * of these are quoted as usual.
 */
export const cmdArgs = (args: string[]): string => {
  const pieces = args.map((arg) => (/[&|<>^%]/.test(arg) ? arg.split('%').map(quoted).join('%') : quoteArg(arg))).join(' ');
  let inQuotes = false;
  return [...pieces].map((c) => {
    if (c === '"') inQuotes = !inQuotes;
    return !inQuotes && /[&|<>^]/.test(c) ? '^^^' + c : c;
  }).join('');
};

/** The command line ptyhost starts; when the program is cmd.exe its arguments are quoted for cmd (cmdArgs). */
export const commandLine = (file: string, args: string[]): string =>
  path.win32.basename(file).toLowerCase() === 'cmd.exe' ? [quoteArg(file), cmdArgs(args)].filter(Boolean).join(' ') : [file, ...args].map(quoteArg).join(' ');

export type Helper = 'ptyhost' | 'gitshim' | 'vswhere';

const sourceHash = (name: Helper): string => crypto.createHash('sha256').update(fs.readFileSync(path.join(launchDir, 'sandbox', name + '.cs'))).digest('hex').slice(0, 12);

/** %TEMP%\agent-sandbox\<name>-<hash>.exe, compiled from this launch's sandbox\<name>.cs the first time it is needed. */
export const ensureCompiled = (name: Helper): string => {
  const exe = path.join(os.tmpdir(), 'agent-sandbox', name + '-' + sourceHash(name) + '.exe');
  if (exists(exe)) return exe;
  if (!exists(CSC)) throw new Error('The .NET Framework C# compiler was not found at ' + CSC + ' (it ships with Windows 10/11).');
  mkdirp(path.dirname(exe));
  const result = spawnSync(CSC, ['/nologo', '/optimize', '/target:exe', '/out:' + exe, path.join(launchDir, 'sandbox', name + '.cs')], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Compiling ' + name + ' failed: ' + ((result.stdout ?? '') + (result.stderr ?? '')).trim().slice(0, 1500));
  return exe;
};

export const ensurePtyHost = (): string => ensureCompiled('ptyhost');

export const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  // Loopback: finding a port must not count as "node listens on the network" (that is what raises firewall prompts).
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
});

const portOpen = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

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

/** Removes helper builds older versions left in persistent storage, and interrupted downloads in the tools folder. */
export const pruneToolLeftovers = (): void => {
  for (const legacy of ['ptyhost', 'gitshim']) fs.rmSync(path.join(toolsDir, legacy), { recursive: true, force: true });
  for (const name of fs.readdirSync(toolsDir).filter((n) => /\.staging-[0-9a-f]+$/i.test(n))) fs.rmSync(path.join(toolsDir, name), { recursive: true, force: true });
};
