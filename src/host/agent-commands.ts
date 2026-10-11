// (Beta) Agent commands: with agentCommands.enabled, typing an agent's own command on this PC (claude, codex, ...) starts
// it in a hidden sandbox for the folder you are in and attaches that terminal. Small forwarding files in
// <storage>\agent-commands go first on YOUR PATH (so they win over npm's and the installers' copies); turning it off
// removes the files and that one PATH entry. SANDBOX_AGENT_DIRECT=1 runs the real agent on this PC instead.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Config } from '../core/types.js';
import { ensureDir, fileExists } from '../core/util.js';
import { writeFileAtomic } from '../shared/rundir.js';
import { safeRemove } from '../shared/safe-remove.js';
import { SYSTEM } from '../shared/system.js';
import { refuseInSelfTest } from './test-guard.js';

export const commandsDir = (storageRoot: string): string => path.join(storageRoot, 'agent-commands');

/** Marks files this tool wrote, so only those are ever replaced or removed. */
const MARKER = 'windows-development-sandbox agent command';
const EXTENSIONS = ['.exe', '.cmd', '.bat'];

export interface AgentCommand { harness: string; command: string; real: string }

/** cmd.exe expands % and ^ even inside quotes: such paths cannot go into a forwarding file safely. */
const cmdSafe = (p: string): boolean => !/[%"^\r\n]/.test(p);

/** The agent's own executable on this PC, skipping this tool's forwarding files. */
export const realAgent = (command: string, skipDir: string, pathValue = process.env.PATH ?? process.env.Path ?? ''): string | null => {
  const skip = path.resolve(skipDir).toLowerCase();
  const dirs = pathValue.split(path.delimiter).filter((d) => d && path.resolve(d).toLowerCase() !== skip);
  for (const dir of dirs) for (const ext of EXTENSIONS) {
    const candidate = path.join(dir, command + ext);
    if (fileExists(candidate)) return candidate;
  }
  return null;
};

/** The agents that get a forwarding command: installed on this PC, and listed (or "auto" = all of them). */
export const agentCommands = (config: Config, storageRoot: string, pathValue?: string): AgentCommand[] => {
  const wanted = config.agentCommands.agents;
  return Object.entries(config.harnesses).flatMap(([harness, h]): AgentCommand[] => {
    if (wanted !== 'auto' && !wanted.includes(harness)) return [];
    const command = h.npmBin ?? (h.hostExecutable ? path.parse(h.hostExecutable).name : harness);
    const real = /^[A-Za-z0-9._-]+$/.test(command) ? realAgent(command, commandsDir(storageRoot), pathValue) : null;
    return real && cmdSafe(real) ? [{ harness, command, real }] : [];
  });
};

/** The .cmd file for one agent (cmd, PowerShell and Windows Terminal all run it). */
export const forwardingCmd = (a: AgentCommand, node: string, entry: string): string => [
  '@echo off',
  'rem ' + MARKER + ' (Beta). Turn off: sandbox agent-commands off. Run the real one: set SANDBOX_AGENT_DIRECT=1',
  'if "%SANDBOX_AGENT_DIRECT%"=="1" goto direct',
  '"' + node + '" "' + entry + '" launch --harness ' + a.harness + ' --headless --terminal -- %*',
  'exit /b %errorlevel%',
  ':direct',
  'call "' + a.real + '" %*',
  '',
].join('\r\n');

/** The same for Git Bash, which looks for a file without an extension. */
export const forwardingSh = (a: AgentCommand, node: string, entry: string): string => {
  const posix = (p: string): string => p.replace(/^([A-Za-z]):/, (_m, d: string) => '/' + d.toLowerCase()).replace(/\\/g, '/');
  const q = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
  return [
    '#!/bin/sh',
    '# ' + MARKER + ' (Beta). Turn off: sandbox agent-commands off. Run the real one: SANDBOX_AGENT_DIRECT=1',
    'if [ "$SANDBOX_AGENT_DIRECT" = "1" ]; then exec ' + q(posix(a.real)) + ' "$@"; fi',
    'exec ' + q(posix(node)) + ' ' + q(posix(entry)) + ' launch --harness ' + a.harness + ' --headless --terminal -- "$@"',
    '',
  ].join('\n');
};

/** Runs a PowerShell script that edits YOUR PATH (HKCU\Environment) unexpanded, then tells Windows it changed. */
const editUserPath = (dir: string, add: boolean): void => {
  refuseInSelfTest('change your PATH');
  const quoted = "'" + dir.replace(/'/g, "''") + "'";
  const script = [
    '$dir = ' + quoted,
    "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
    'try {',
    "  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "  $rest = @($raw -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $dir.TrimEnd('\\') })",
    // First, so these commands win over the agents' own folders (also on YOUR PATH).
    add ? '  $new = (@($dir) + $rest) -join \';\'' : "  $new = $rest -join ';'",
    '  if ($new -eq $raw.TrimEnd(\';\')) { exit 0 }',
    "  if ($new.Length -gt 32000) { Write-Error 'PATH too long'; exit 3 }",
    "  $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }",
    "  $key.SetValue('Path', $new, $kind)",
    '} finally { $key.Close() }',
    "Add-Type -Namespace WdsAgents -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\", CharSet = System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'",
    '$ignored = [UIntPtr]::Zero',
    "[void][WdsAgents.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$ignored)",
  ].join('\n');
  const result = spawnSync(SYSTEM.powershell(), ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status === 3) throw new Error('Your PATH is too long to add ' + dir + '.');
  if (result.status !== 0) throw new Error('Could not ' + (add ? 'add ' + dir + ' to' : 'remove ' + dir + ' from') + ' your PATH: ' + (result.stderr || result.error?.message || 'exit ' + result.status).trim());
};

const ownFiles = (dir: string): string[] => fs.existsSync(dir)
  ? fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => { try { return fs.lstatSync(f).isFile() && fs.readFileSync(f, 'utf8').includes(MARKER); } catch { return false; } })
  : [];

export interface Reconciled { on: boolean; commands: AgentCommand[]; changed: boolean }

/**
 * Makes this PC match agentCommands: on = a forwarding file per installed agent and the folder first on your PATH;
 * off = no files, no PATH entry. Only touches files it wrote and its own PATH entry; does nothing when already right.
 */
export const reconcileAgentCommands = (config: Config, storageRoot: string, node: string, entry: string): Reconciled => {
  const dir = commandsDir(storageRoot);
  if (!config.agentCommands.enabled) {
    if (!fs.existsSync(dir)) return { on: false, commands: [], changed: false };
    for (const f of ownFiles(dir)) fs.rmSync(f, { force: true });
    editUserPath(dir, false);
    if (fs.readdirSync(dir).length === 0) safeRemove(dir, storageRoot);
    return { on: false, commands: [], changed: true };
  }
  if (!cmdSafe(node) || !cmdSafe(entry)) throw new Error('This tool is installed in a folder whose path has % " or ^, which cannot go into a command file safely.');
  const commands = agentCommands(config, storageRoot);
  ensureDir(dir);
  const wanted = new Map<string, string>();
  for (const a of commands) {
    wanted.set(path.join(dir, a.command + '.cmd'), forwardingCmd(a, node, entry));
    wanted.set(path.join(dir, a.command), forwardingSh(a, node, entry));
  }
  let changed = false;
  for (const f of ownFiles(dir)) if (!wanted.has(f)) { fs.rmSync(f, { force: true }); changed = true; }
  for (const [file, text] of wanted) {
    const current = fileExists(file) ? fs.readFileSync(file, 'utf8') : null;
    // A file of the same name that this tool did not write is never replaced.
    if (current !== null && !current.includes(MARKER)) continue;
    if (current !== text) { writeFileAtomic(file, text); changed = true; }
  }
  const onPath = (process.env.PATH ?? '').split(path.delimiter).some((d) => path.resolve(d).toLowerCase() === path.resolve(dir).toLowerCase());
  if (changed || !onPath) editUserPath(dir, true);
  return { on: true, commands, changed: changed || !onPath };
};
