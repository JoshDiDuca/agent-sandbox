import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { GuestResponse } from '../../../core/types.js';
import { execInSandbox } from '../../../host/channel/index.js';
import { insideSandbox } from '../../../host/sandbox/index.js';
import { NeedsRestart } from '../../../host/projects/index.js';
import { fail, safeText } from '../../../core/util/index.js';
import { printJson } from '../../output/index.js';
import { requireOnPc, requireRunning, sandboxAlive, type Context } from '../context.js';
import { readySandbox } from '../launch/index.js';
import { hereDir, joinHere, provisionJoined } from '../projects/index.js';
import { working } from '../../output/index.js';

/** What a command run in the sandbox printed (text from the sandbox: through safeText), or why it failed. */
const printExecResult = (result: GuestResponse): void => {
  if (result.stdout) process.stdout.write(safeText(result.stdout));
  if (result.stderr) process.stderr.write(safeText(result.stderr));
  if (!result.ok && !result.stdout && !result.stderr) console.error(safeText(result.message));
};

/** The guest folder for this folder, joining the running sandbox (and setting the project up) when needed. */
const guestFolderHere = async (ctx: Context, what: string): Promise<string> => {
  const ready = await readySandbox(ctx.dataPath);
  try {
    const joined = await joinHere(ctx, ready);
    for (const note of joined.notes) console.error(note);
    await provisionJoined(ctx, joined);
    return joined.guestDir;
  } catch (e) {
    if (!(e instanceof NeedsRestart)) throw e;
    return fail(
      hereDir(ctx) + ' is not in the running sandbox (' + e.reason + '), so "sandbox ' + what + '" cannot run there.',
      'sandbox claude (or sandbox start) from that folder offers a restart that adds it; or add its parent folder as a root: sandbox projects roots add "' +
        path.dirname(e.hostDir) +
        '"',
    );
  }
};

export const exec = async (ctx: Context): Promise<number> => {
  const command = [...ctx.options.positionals, ...ctx.options.passthrough];
  if (command.length === 0) fail('No command given.', 'Usage: sandbox exec [--timeout <s>] -- <command> [args...]');
  requireOnPc('exec');
  requireRunning();
  const cwd = await guestFolderHere(ctx, 'exec');
  const result = await execInSandbox(ctx.dataPath, command, cwd, ctx.options.timeout, sandboxAlive);
  if (!printJson(ctx, result)) printExecResult(result);
  return result.exitCode ?? 1;
};

/** `sandbox db`: runs the sandbox's own `sbx-db` in this folder's project, which knows its database versions and ports. */
export const db = async (ctx: Context): Promise<number> => {
  const [action = 'list', name] = ctx.options.positionals;
  if (!['list', 'start', 'stop'].includes(action))
    fail(
      'Unknown db action "' + action + '".',
      'Use: sandbox db  (list)  or  sandbox db start|stop <postgres|mysql|mongodb|redis|dynamodb>',
    );
  if (action !== 'list' && !name)
    fail('Which database?', 'Usage: sandbox db ' + action + ' <postgres|mysql|mongodb|redis|dynamodb>');
  // Already inside the sandbox: run the database tool here instead of asking the sandbox from outside.
  if (insideSandbox())
    return (
      spawnSync(
        process.execPath,
        [path.join(ctx.packageRoot, 'dist', 'runtime', 'db.js'), action, ...(name ? [name] : [])],
        { stdio: 'inherit', windowsHide: true },
      ).status ?? 1
    );
  requireRunning('Start one with: sandbox start --database <name>');
  const cwd = await guestFolderHere(ctx, 'db');
  // Starting can download the database the first time.
  const result = await working(
    (action === 'list' ? 'Asking' : action === 'start' ? 'Starting' : 'Stopping') +
      ' the database' +
      (name ? ' ' + name : 's') +
      ' in the sandbox',
    () => execInSandbox(ctx.dataPath, ['sbx-db', action, ...(name ? [name] : [])], cwd, 1800, sandboxAlive),
  );
  printExecResult(result);
  return result.exitCode ?? 1;
};
