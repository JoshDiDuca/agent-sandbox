import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
//TS import type { Config, HostProbe } from './types.js';
import { ensureDir, fail, fileExists, findOnPath, isWin, realPath, runPowerShell, dirExists } from './util.js';

export function probeHost(config/*: Config*/, harnessName/*: string*/)/*: HostProbe*/ {
  const probe/*: HostProbe*/ = { nodeDir: null, harnessExe: null };
  if (!config.provisioning.copyFromHost) return probe;

  const setting = config.provisioning.node.hostDir;
  const candidate = setting === 'auto' ? (isWin ? path.dirname(process.execPath) : null) : setting;
  if (candidate && fileExists(path.join(candidate, 'node.exe')) && fileExists(path.join(candidate, 'node_modules', 'npm', 'bin', 'npm-cli.js'))) {
    probe.nodeDir = realPath(candidate);
  }

  const harness = config.harnesses[harnessName];
  if (harness && harness.hostExecutable) {
    let found/*: string | null*/ = null;
    if (harness.hostDir && harness.hostDir !== 'auto') {
      const explicit = path.join(harness.hostDir, harness.hostExecutable);
      if (fileExists(explicit)) found = explicit;
    } else {
      found = findOnPath([harness.hostExecutable]);
      const home = process.env.USERPROFILE ?? os.homedir();
      const local = path.join(home, '.local', 'bin', harness.hostExecutable);
      if (!found && fileExists(local)) found = local;
    }
    if (found) { const real = realPath(found); probe.harnessExe = { dir: path.dirname(real), file: path.basename(real) }; }
  }
  return probe;
}

export function isSandboxRunning()/*: boolean*/ {
  if (!isWin) return false;
  for (const image of ['WindowsSandboxClient.exe', 'WindowsSandbox.exe']) {
    const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + image, '/NH'], { encoding: 'utf8' });
    if (result.stdout && result.stdout.toLowerCase().includes(image.toLowerCase())) return true;
  }
  return false;
}

export function sandboxFeatureInstalled()/*: boolean*/ {
  return isWin && fileExists(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsSandbox.exe'));
}

export function startSandbox(wsbPath/*: string*/)/*: void*/ {
  if (!isWin) fail('Launching Windows Sandbox requires Windows. Use "generate" on other platforms.');
  if (!sandboxFeatureInstalled()) fail('Windows Sandbox is not enabled. Run in an elevated PowerShell: Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All  (then reboot).');
  if (isSandboxRunning()) fail('A Windows Sandbox is already running (Windows allows one at a time). Close it, then launch again.');
  const result = spawnSync('cmd.exe', ['/d', '/c', 'start', '""', '"' + wsbPath + '"'], { stdio: 'inherit', windowsVerbatimArguments: true });
  if (result.error) throw result.error;
}

export function hostClaude(storageRoot/*: string*/, binDir/*: string*/, personal/*: boolean*/, args/*: string[]*/)/*: number*/ {
  const exe = findOnPath(['claude.exe', 'claude.cmd'], [binDir]);
  if (!exe) fail('Host Claude Code was not found on PATH (searched for claude.exe / claude.cmd).');
  const env/*: NodeJS.ProcessEnv*/ = { ...process.env };
  if (!personal) {
    const profile = path.join(storageRoot, 'host', 'claude');
    ensureDir(profile);
    env.CLAUDE_CONFIG_DIR = profile;
    console.warn('Host Claude is NOT sandboxed. Using separate profile: ' + profile + ' (pass --personal to use your normal one).');
  }
  const isCmd = exe.toLowerCase().endsWith('.cmd');
  const result = isCmd ? spawnSync('cmd.exe', ['/d', '/c', exe, ...args], { stdio: 'inherit', env }) : spawnSync(exe, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function installCommands(projectRoot/*: string*/, shadowClaude/*: boolean*/)/*: void*/ {
  const binDir = path.join(projectRoot, 'bin');
  ensureDir(binDir);
  const node = '"' + process.execPath + '"';
  const entry = '"' + path.join(projectRoot, 'dist', 'index.js') + '"';
  const wrappers/*: Record<string, string>*/ = {
    'agent-sandbox.cmd': '@echo off\r\n' + node + ' ' + entry + ' %*\r\n',
    'claude-sbx.cmd': '@echo off\r\n' + node + ' ' + entry + ' launch --here --harness claude -- %*\r\n',
    'codex-sbx.cmd': '@echo off\r\n' + node + ' ' + entry + ' launch --here --harness codex -- %*\r\n',
    'gemini-sbx.cmd': '@echo off\r\n' + node + ' ' + entry + ' launch --here --harness gemini -- %*\r\n',
    'claude-host.cmd': '@echo off\r\n' + node + ' ' + entry + ' host-claude -- %*\r\n',
  };
  if (shadowClaude) wrappers['claude.cmd'] = wrappers['claude-sbx.cmd'];
  for (const [name, content] of Object.entries(wrappers)) fs.writeFileSync(path.join(binDir, name), content, 'ascii');
  if (!isWin) { console.log('Wrappers written to ' + binDir + ' (PATH update is Windows-only).'); return; }
  const bin = binDir.replace(/'/g, "''");
  const script = [
    "$bin = '" + bin + "'",
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    '$parts = @()',
    "if ($current) { $parts = @($current -split ';' | Where-Object { $_ -and ($_ -ne $bin) }) }",
    shadowClaude ? '$updated = @($bin) + $parts' : '$updated = $parts + @($bin)',
    "[Environment]::SetEnvironmentVariable('Path', ($updated -join ';'), 'User')",
  ].join('\n');
  const status = runPowerShell(script);
  if (status !== 0) fail('Updating the user PATH failed (exit ' + status + ').');
  console.log('Installed: agent-sandbox, claude-sbx, codex-sbx, gemini-sbx, claude-host' + (shadowClaude ? ', claude (shadows the real one)' : ''));
  console.log('Open a NEW terminal for PATH changes to apply. Run claude-sbx from inside any project folder.');
}

export function doctor(config/*: Config*/, harnessName/*: string*/)/*: void*/ {
  const rows/*: string[][]*/ = [];
  rows.push(['Windows', isWin ? 'yes' : 'NO (launch needs Windows)']);
  rows.push(['Windows Sandbox feature', sandboxFeatureInstalled() ? 'enabled' : 'NOT enabled']);
  rows.push(['Sandbox already running', isSandboxRunning() ? 'YES (close it first)' : 'no']);
  rows.push(['Free host RAM (MB)', String(Math.floor(os.freemem() / 1048576))]);
  const probe = probeHost(config, harnessName);
  rows.push(['Provisioning mode', config.provisioning.copyFromHost ? 'copy from this PC' + (config.provisioning.fallbackToInstall ? ', fall back to install' : ', no fallback') : 'download/install inside sandbox']);
  rows.push(['Host Node dir', probe.nodeDir ?? '(none found; will download)']);
  rows.push(['Host ' + harnessName, probe.harnessExe ? path.join(probe.harnessExe.dir, probe.harnessExe.file) : '(none found; will npm install)']);
  rows.push(['Storage root', config.storage.root + (dirExists(config.storage.root) ? '' : ' (will be created)')]);
  for (const [k, v] of rows) console.log(k.padEnd(26) + v);
}
