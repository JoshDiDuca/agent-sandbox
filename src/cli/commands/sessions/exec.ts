import path from 'node:path';
import type { GuestResponse } from '../../../core/types.js';
import { SandboxChannel } from '../../../host/channel/index.js';
import { NeedsRestart } from '../../../host/projects/index.js';
import { fail, safeText } from '../../../core/util/index.js';
import { printJson, working } from '../../output/index.js';
import { requireOnPc, requireRunning, type Context } from '../context.js';
import { readySandbox } from '../launch/index.js';
import { hereDir, joinHere, provisionJoined } from '../projects/index.js';
import { DatabasesService } from '../../services/index.js';

/** What a command run in the sandbox printed (text from the sandbox: through safeText), or why it failed. */
function printExecResult(result: GuestResponse): void {
  if (result.stdout) process.stdout.write(safeText(result.stdout));
  if (result.stderr) process.stderr.write(safeText(result.stderr));
  if (!result.ok && !result.stdout && !result.stderr) console.error(safeText(result.message));
}

/** The guest folder for this folder, joining the running sandbox (and setting the project up) when needed. */
async function guestFolderHere(ctx: Context, what: string): Promise<string> {
  const ready = await readySandbox(ctx.dataPath);
  try {
    // A command needs no restart for what the project wants at boot: it runs without them (and says so).
    const joined = await joinHere(ctx, ready, { noRestart: true });
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
}

export async function exec(ctx: Context): Promise<number> {
  const command = [...ctx.options.positionals, ...ctx.options.passthrough];
  if (command.length === 0) fail('No command given.', 'Usage: sandbox exec [--timeout <s>] -- <command> [args...]');
  requireOnPc('exec');
  requireRunning();
  const cwd = await guestFolderHere(ctx, 'exec');
  const result = await new SandboxChannel(ctx.dataPath).exec(command, cwd, ctx.options.timeout);
  if (!printJson(ctx, result)) printExecResult(result);
  return result.exitCode ?? 1;
}

/**
 * `sandbox db`: runs the sandbox's own `sbx-db` in this folder's project, which knows its database versions and ports.
 */
export async function db(ctx: Context): Promise<number> {
  const [rawAction = 'list', name] = ctx.options.positionals;
  const databases = new DatabasesService(ctx);
  const action = databases.validate(rawAction, name);
  // Already inside the sandbox: run the database tool here instead of asking the sandbox from outside.
  if (databases.isInsideSandbox()) return databases.runInside(action, name);
  requireRunning('Start one with: sandbox start --database <name>');
  const cwd = await guestFolderHere(ctx, 'db');
  const result = await working(
    (action === 'list' ? 'Asking' : action === 'start' ? 'Starting' : 'Stopping') +
      ' the database' +
      (name ? ' ' + name : 's') +
      ' in the sandbox',
    () => databases.run(action, name, cwd),
  );
  printExecResult(result);
  return result.exitCode ?? 1;
}
