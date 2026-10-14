// The Windows Sandbox command line (wsb.exe), Windows 11 24H2+ with the updated Windows Sandbox. Used only where it
// adds something the .wsb file cannot: `wsb share` puts a folder into the RUNNING sandbox. Launching always stays on
// the .wsb path, which works on every Windows version. UNTESTED: the machines this was built on predate the CLI, so
// every call is checked and any failure falls back (the caller offers a restart instead), with the error shown.
// Syntax from Microsoft's docs (learn.microsoft.com, "Windows Sandbox command line"):
//   wsb start [--id <id>] [-c|--config <xml>]   wsb list [--raw]   wsb ip --id <id>   wsb stop --id <id>
//   wsb share --id <id> -f|--host-path <host> -s|--sandbox-path <sandbox> [-w|--allow-write]
//   wsb exec --id <id> -c <command> -r System|ExistingLogin [-d <dir>]   wsb connect --id <id>   --raw = JSON output
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { refuseInSelfTest } from '../test-guard.js';

const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const MAX_OUTPUT = 1024 * 1024;

/** Where wsb.exe can be: the Store app's alias, then System32 (never by bare name; cwd is often the workspace). */
export function wsbCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wsb.exe') : '',
    path.join(env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows', 'System32', 'wsb.exe'),
  ].filter(Boolean);
}

export function findWsb(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  return process.platform === 'win32' || exists !== fs.existsSync
    ? (wsbCandidates(env).find((p) => exists(p)) ?? null)
    : null;
}

// ---- parsing (pure; the tests feed it recorded output) ---------------------------------------------------------

/** The version from `wsb --version` ("0.1.32.0", "wsb 1.2.3+abc"). */
export function parseVersion(out: string): string | null {
  return /\d+\.\d+(?:\.\d+){0,2}/.exec(out)?.[0] ?? null;
}

/** Subcommand names from `wsb --help` (the lines under "Commands:"). */
export function parseCommands(help: string): string[] {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*commands:\s*$/i.test(l));
  if (start < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && line.trim()) break;
    const m = /^\s{1,8}([a-z][a-z-]*)\b/.exec(line);
    if (m) names.push(m[1].toLowerCase());
  }
  return names;
}

export interface WsbSandbox {
  id: string;
  status: string;
}

/** `wsb list --raw` (JSON: an array, or an object holding one) or the plain table: the sandboxes and their status. */
export function parseList(out: string): WsbSandbox[] {
  const fromObject = (o: unknown): WsbSandbox | null => {
    if (!o || typeof o !== 'object') return null;
    const entries = Object.entries(o as Record<string, unknown>);
    const id = entries.find(([k, v]) => /^id$/i.test(k) && typeof v === 'string' && GUID.test(v))?.[1] as
      string | undefined;
    const status = entries.find(([k]) => /^(status|state)$/i.test(k))?.[1];
    return id ? { id: GUID.exec(id)![0], status: typeof status === 'string' ? status : 'unknown' } : null;
  };
  try {
    const parsed: unknown = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : (Object.values(parsed as object).find(Array.isArray) ?? [parsed]);
    return (list as unknown[]).map(fromObject).filter((s): s is WsbSandbox => s !== null);
  } catch {
    /* the table */
  }
  return out.split(/\r?\n/).flatMap((line) => {
    const id = GUID.exec(line)?.[0];
    if (!id) return [];
    return [{ id, status: /\brunning\b/i.test(line) ? 'Running' : /\bstopped\b/i.test(line) ? 'Stopped' : 'unknown' }];
  });
}

/** `wsb ip --id <id>`: the first IPv4 address in the output. */
export function parseIp(out: string): string | null {
  return /\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(out)?.[0] ?? null;
}

// ---- calls -------------------------------------------------------------------------------------------------------

export interface WsbResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

const call = (exe: string, args: string[], timeoutMs = 60000): WsbResult => {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_OUTPUT });
  const stdout = String(r.stdout ?? '').slice(0, MAX_OUTPUT);
  const stderr = String(r.stderr ?? '').slice(0, MAX_OUTPUT);
  if (r.error) return { ok: false, stdout, stderr, error: r.error.message };
  return {
    ok: r.status === 0,
    stdout,
    stderr,
    ...(r.status === 0
      ? {}
      : { error: (stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' ') || 'exit code ' + r.status }),
  };
};

export interface Wsb {
  exe: string;
  version: string | null;
  commands: string[];
  has: (command: string) => boolean;
}

/** The CLI and what it offers, or null on Windows versions without it. */
export function detectWsb(env: NodeJS.ProcessEnv = process.env): Wsb | null {
  const exe = findWsb(env);
  if (!exe) return null;
  const version = parseVersion(call(exe, ['--version'], 15000).stdout);
  const help = call(exe, ['--help'], 15000);
  const commands = parseCommands(help.stdout + '\n' + help.stderr);
  // An unreadable help text is not proof of anything: assume the documented commands.
  const known = commands.length ? commands : ['start', 'list', 'exec', 'stop', 'share', 'connect', 'ip'];
  return { exe, version, commands: known, has: (c) => known.includes(c) };
}

/** The running sandbox's id: the only running one (with several, none is guessed). */
export function runningSandboxId(wsb: Wsb): { id: string | null; error?: string } {
  const listed = call(wsb.exe, ['list', '--raw'], 20000);
  const all = parseList(listed.ok ? listed.stdout : call(wsb.exe, ['list'], 20000).stdout);
  const running = all.filter((s) => !/stopped/i.test(s.status));
  if (running.length === 1) return { id: running[0].id };
  return {
    id: null,
    error: running.length
      ? running.length + ' sandboxes are running (wsb list); cannot tell which one is ours'
      : 'wsb list shows no running sandbox (one started from a .wsb file may not be listed)',
  };
}

/** Shares a folder of this PC into the running sandbox at `sandboxPath` (read/write unless readOnly). */
export function shareFolder(wsb: Wsb, id: string, hostPath: string, sandboxPath: string, readOnly = false): WsbResult {
  refuseInSelfTest('share a folder into Windows Sandbox');
  if (!GUID.test(id)) return { ok: false, stdout: '', stderr: '', error: 'not a sandbox id: ' + id };
  return call(wsb.exe, [
    'share',
    '--id',
    id,
    '-f',
    hostPath,
    '-s',
    sandboxPath,
    ...(readOnly ? [] : ['--allow-write']),
  ]);
}

export function sandboxIp(wsb: Wsb, id: string): string | null {
  return GUID.test(id) ? parseIp(call(wsb.exe, ['ip', '--id', id], 15000).stdout) : null;
}
