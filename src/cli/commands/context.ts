// What every command receives, plus the small helpers they share.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import type { CliOptions } from '../args.js';
import type { LoadedConfig } from '../../core/types.js';
import { loadConfig, userDir } from '../../core/config.js';
import { expandPath, fail, isInsideOrEqual } from '../../core/util.js';
import { GUEST_DATA_DIR, insideSandbox, isSandboxRunning } from '../../host/platform.js';

export interface Context { packageRoot: string; entry: string; options: CliOptions; loaded: LoadedConfig; storageRoot: string; dataPath: string }

/** Keeps ~/.agent-sandbox/*.schema.json in step with the installed version (local schema paths editors trust). */
const refreshSchemas = (packageRoot: string): void => {
  const source = path.join(packageRoot, 'schemas');
  if (!fs.existsSync(source)) return;
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    for (const name of fs.readdirSync(source)) {
      const target = path.join(userDir(), name);
      const text = fs.readFileSync(path.join(source, name), 'utf8');
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) fs.writeFileSync(target, text, 'utf8');
    }
  } catch { /* editor help only; never block a command over it */ }
};

export const createContext = (packageRoot: string, entry: string, options: CliOptions): Context => {
  refreshSchemas(packageRoot);
  const loaded = loadConfig(options.config);
  const storageRoot = expandPath(loaded.config.storage.root, loaded.base);
  // Inside a sandbox, the sandbox's own data folder is the one to talk to.
  return { packageRoot, entry, options, loaded, storageRoot, dataPath: insideSandbox() ? GUEST_DATA_DIR : path.join(storageRoot, 'data', loaded.config.storage.dataName) };
};

/** Prints rows as aligned columns (the last column is not padded). */
export const table = (rows: string[][]): void => {
  const widths = _.range(_.max(rows.map((r) => r.length)) ?? 0).map((i) => _.max(rows.map((r) => (r[i] ?? '').length)) ?? 0);
  for (const row of rows) console.log(row.map((cell, i) => (i === row.length - 1 ? cell : _.padEnd(cell, widths[i] + 2))).join(''));
};

/** Prints `value` as JSON when --json was given; returns whether it did. */
export const printJson = (ctx: Context, value: unknown): boolean => {
  if (ctx.options.json) console.log(JSON.stringify(value, null, 2));
  return ctx.options.json;
};

export const sandboxAlive = (): boolean => isSandboxRunning();

export const requireRunning = (hint = ''): void => { if (!isSandboxRunning()) fail('No Windows Sandbox is running.', hint || 'Start one with sandbox claude.'); };

/** Maps a folder on this PC to its path inside the running sandbox (only folders inside the mapped workspace exist there). */
export const guestPathFor = (hostDir: string, workspaceHost: string, guestWorkspace: string): string => {
  if (!isInsideOrEqual(workspaceHost, hostDir)) fail('The running sandbox works on ' + workspaceHost + ', and Windows Sandbox cannot add folders while it runs.', 'Run from inside that folder, or stop the sandbox (sandbox stop) and launch again from ' + hostDir + '.');
  const rel = path.relative(workspaceHost, hostDir);
  return rel ? path.win32.join(guestWorkspace, rel) : guestWorkspace;
};

/** The guest folder for the current directory (or --workspace) in the running sandbox. */
export const currentGuestDir = (ctx: Context, workspaceHost: string, guestWorkspace: string): string =>
  guestPathFor(path.resolve(ctx.options.workspace ?? process.cwd()), workspaceHost, guestWorkspace);
