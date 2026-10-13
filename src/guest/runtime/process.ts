import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { moveIntoPlace, spawnAsync, stagingFolder } from '../../shared/download/index.js';
import { safeRemove } from '../../shared/io/safe-remove.js';
import { SYSTEM } from '../../shared/system.js';
import { scriptArgs } from '../../shared/scripts.js';
import { isWin } from './paths.js';

/** Runs a program, streaming output, and throws with a readable message when it fails. */
export const exec = (file: string, args: string[], options: SpawnSyncOptions = {}): void => {
  const result = spawnSync(file, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(path.basename(file) + ' ' + args.slice(0, 3).join(' ') + ' failed with exit code ' + result.status);
};

/** exec without blocking: other toolchains keep downloading while this one runs an installer. */
export const execAsync = async (file: string, args: string[], options: SpawnOptions = {}): Promise<void> => {
  const code = await spawnAsync(file, args, { stdio: 'inherit', ...options });
  if (code !== 0)
    throw new Error(path.basename(file) + ' ' + args.slice(0, 3).join(' ') + ' failed with exit code ' + code);
};

export const execOutput = (file: string, args: string[], options: SpawnSyncOptions = {}): string => {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, ...options });
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
};

/** Runs sandbox\<name> (a .ps1 in the launch folder) with `args`; throws when it fails. */
export function runScript(name: string, args: readonly string[] = []): void {
  exec(SYSTEM.powershell(), scriptArgs(name, args));
}

/** runScript for what it prints ('' when it fails). */
export function scriptOutput(name: string, args: readonly string[] = [], options: SpawnSyncOptions = {}): string {
  return execOutput(SYSTEM.powershell(), scriptArgs(name, args), options);
}

/** Runs sandbox\<name> with a JSON file (-<param> path) holding `data`, removed afterwards. */
export function runScriptWithJson(name: string, param: string, data: unknown, args: readonly string[] = []): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  const file = path.join(dir, 'input.json');
  try {
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    runScript(name, ['-' + param, file, ...args]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Copies a folder with robocopy (fast, restartable), or just the named files in it; exit codes below 8 mean success. */
export const robocopy = (from: string, to: string, files: string[] = []): void => {
  if (!isWin) {
    if (!files.length) {
      fs.cpSync(from, to, { recursive: true });
      return;
    }
    fs.mkdirSync(to, { recursive: true });
    for (const f of files.filter((f) => fs.existsSync(path.join(from, f))))
      fs.copyFileSync(path.join(from, f), path.join(to, f));
    return;
  }
  const what = files.length ? files : ['/E', '/MT:16'];
  const result = spawnSync(
    SYSTEM.robocopy(),
    [from, to, ...what, '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1', '/XJ'],
    { stdio: 'ignore', windowsHide: true },
  );
  if ((result.status ?? 16) >= 8)
    throw new Error('robocopy ' + from + ' -> ' + to + ' failed (exit ' + result.status + ')');
};

/**
 * A Node install without its global packages (nvm keeps those per version: often tens of thousands of small files,
 * which is what made copying from this PC slow). Same file list as Copy-NodeFromHost in sandbox/bootstrap.ps1.
 * Copied into a staging folder and renamed into place: node.exe alone (an interrupted copy) must not look like a full install.
 */
export const copyNode = (from: string, to: string): void => {
  const work = stagingFolder(to);
  try {
    robocopy(from, work, ['node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd']);
    robocopy(path.join(from, 'node_modules', 'npm'), path.join(work, 'node_modules', 'npm'));
    moveIntoPlace(work, to);
  } finally {
    safeRemove(work, path.dirname(work));
  }
};
