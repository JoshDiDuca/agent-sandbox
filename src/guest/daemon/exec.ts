// `exec` requests: a command run for the host in the workspace.
import { spawn } from 'node:child_process';
import type { GuestRequest } from '../../core/types.js';
import { SYSTEM } from '../../shared/system.js';
import { exists } from '../runtime/fs.js';
import { errMsg } from '../../core/util/errors.js';
import { provisioner } from './project-provisioner.js';
import { insideWorkspace, respond } from './state.js';

const MAX_OUTPUT = 1024 * 1024;

function quoteForCmd(a: string): string {
  return /[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a;
}

function cap(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n[output truncated]' : s;
}

/** Runs a command for the host without blocking the daemon (other requests and pings keep being answered). */
export function execCommand(req: Extract<GuestRequest, { kind: 'exec' }>): void {
  if (!insideWorkspace(req.cwd) || !exists(req.cwd)) {
    respond(req.id, { ok: false, message: 'Folder is not inside the sandbox workspace: ' + req.cwd });
    return;
  }
  // chcp 65001 first: console programs then write UTF-8 (not the OEM code page) into the pipes.
  // In a project registered after boot, its own environment (its Node, Python, database variables).
  const env = provisioner.provisionedFor(req.cwd)?.env ?? process.env;
  const child = spawn(
    SYSTEM.cmd(),
    ['/d', '/s', '/c', '"chcp 65001>nul & ' + req.command.map(quoteForCmd).join(' ') + '"'],
    { cwd: req.cwd, env, windowsHide: true, windowsVerbatimArguments: true },
  );
  const output = { stdout: '', stderr: '' };
  // setEncoding decodes across chunks: a multi-byte character split between two reads is not mangled.
  const collect =
    (key: 'stdout' | 'stderr') =>
    (d: string): void => {
      if (output[key].length < MAX_OUTPUT) output[key] += d;
    };
  child.stdout.setEncoding('utf8').on('data', collect('stdout'));
  child.stderr.setEncoding('utf8').on('data', collect('stderr'));
  const timer = setTimeout(() => child.kill(), Math.min(req.timeoutSeconds, 3600) * 1000);
  child.on('error', (e) => {
    clearTimeout(timer);
    respond(req.id, { ok: false, message: 'Could not run the command: ' + errMsg(e) });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    respond(req.id, {
      ok: code === 0,
      message: code === null ? 'stopped after ' + req.timeoutSeconds + ' s' : 'exit ' + code,
      exitCode: code ?? -1,
      stdout: cap(output.stdout),
      stderr: cap(output.stderr),
    });
  });
}
