// Builds sandbox/ptyhost.cs with the .NET Framework compiler that ships with Windows (cached by source hash) and
// starts one ptyhost per agent session.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { exists, launchDir, logsDir, mkdirp, toolsDir } from './env.js';

const CSC = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

export const quoteArg = (arg: string): string => (arg !== '' && !/[\s"]/.test(arg) ? arg : '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"');
export const commandLine = (file: string, args: string[]): string => [file, ...args].map(quoteArg).join(' ');

/** Path of the compiled ptyhost.exe for the current source (compiles it the first time). */
export const ensurePtyHost = (): string => {
  const source = path.join(launchDir, 'sandbox', 'ptyhost.cs');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 12);
  const exe = path.join(toolsDir, 'ptyhost', hash, 'ptyhost.exe');
  if (exists(exe)) return exe;
  if (!exists(CSC)) throw new Error('The .NET Framework C# compiler was not found at ' + CSC);
  mkdirp(path.dirname(exe));
  const result = spawnSync(CSC, ['/nologo', '/optimize', '/target:exe', '/out:' + exe, source], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Compiling ptyhost failed: ' + (result.stdout ?? '') + (result.stderr ?? ''));
  return exe;
};

export const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '0.0.0.0', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
});

export const waitForPort = async (port: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('ptyhost did not start listening on port ' + port);
};

export interface PtyHostOptions { exe: string; port: number; token: string; cols: number; rows: number; command: string; restartCommand: string; cwd: string; env: NodeJS.ProcessEnv; id: string }

/** Starts ptyhost detached, so closing a terminal tab never kills the agent; only the agent exiting ends it. */
export const startPtyHost = (o: PtyHostOptions): ChildProcess =>
  spawn(o.exe, [String(o.port), o.token, String(o.cols), String(o.rows), path.join(logsDir, 'ptyhost-' + o.id + '.log'), o.command, o.restartCommand], { cwd: o.cwd, env: o.env, detached: true, stdio: 'ignore', windowsHide: true });

/** Removes ptyhost builds of older sources and interrupted downloads in the tools folder. */
export const pruneToolLeftovers = (currentPtyHost: string | null): void => {
  const builds = path.join(toolsDir, 'ptyhost');
  if (currentPtyHost && exists(builds)) {
    for (const hash of fs.readdirSync(builds).filter((h) => h !== path.basename(path.dirname(currentPtyHost)))) fs.rmSync(path.join(builds, hash), { recursive: true, force: true });
  }
  for (const name of fs.readdirSync(toolsDir).filter((n) => /\.staging-[0-9a-f]+$/i.test(n))) fs.rmSync(path.join(toolsDir, name), { recursive: true, force: true });
};
