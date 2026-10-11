// What every command receives, plus the small helpers they share.
import path from 'node:path';
import _ from 'lodash';
import type { CliOptions } from '../args.js';
import type { LoadedConfig } from '../../core/types.js';
import { loadConfig } from '../../core/config.js';
import { expandPath, fail, isInsideOrEqual } from '../../core/util.js';
import { isSandboxRunning } from '../../host/platform.js';

export interface Context { packageRoot: string; entry: string; options: CliOptions; loaded: LoadedConfig; storageRoot: string; dataPath: string }

export const createContext = (packageRoot: string, entry: string, options: CliOptions): Context => {
  const loaded = loadConfig(options.config);
  const storageRoot = expandPath(loaded.config.storage.root, loaded.base);
  return { packageRoot, entry, options, loaded, storageRoot, dataPath: path.join(storageRoot, 'data', loaded.config.storage.dataName) };
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

export const requireRunning = (hint = ''): void => { if (!isSandboxRunning()) fail('No Windows Sandbox is running.' + (hint ? ' ' + hint : '')); };

/** Maps a folder on this PC to its path inside the running sandbox (only folders inside the mapped workspace exist there). */
export const guestPathFor = (hostDir: string, workspaceHost: string, guestWorkspace: string): string => {
  if (!isInsideOrEqual(workspaceHost, hostDir)) fail('The running sandbox maps ' + workspaceHost + ', and Windows Sandbox cannot add folders while running. Run from inside that folder, or close the sandbox and launch again from ' + hostDir + '.');
  const rel = path.relative(workspaceHost, hostDir);
  return rel ? path.win32.join(guestWorkspace, rel) : guestWorkspace;
};

/** The guest folder for the current directory (or --workspace) in the running sandbox. */
export const currentGuestDir = (ctx: Context, workspaceHost: string, guestWorkspace: string): string =>
  guestPathFor(path.resolve(ctx.options.workspace ?? process.cwd()), workspaceHost, guestWorkspace);
