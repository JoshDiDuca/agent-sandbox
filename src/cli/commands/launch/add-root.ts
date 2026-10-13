import path from 'node:path';
import { select } from '@inquirer/prompts';
import { isWithin, planMirrorWorkspace } from '../../../shared/paths/index.js';
import type { ResolvedRun } from '../../../core/types.js';
import { assertSafeMapping, assertSafeWorkspace } from '../../../core/safe-paths.js';
import { isRootPath } from '../../../core/util/index.js';
import { autoGuestWorkspace, placeInRoot } from '../../../core/run/index.js';
import { type Context } from '../context.js';
import { addToList, setSetting } from '../user-config.js';

/**
 * Asked once per parent folder: map it at every start (a project root), so the projects next to this one open in the
 * running sandbox without a restart. The answer is saved to your config.
 */
export async function maybeAddRoot(ctx: Context, run: ResolvedRun): Promise<void> {
  const { projects } = run.config;
  const parent = path.dirname(run.workspaceHost);
  if (!projects.askToAddRoot || ctx.options.yes || !process.stdin.isTTY || !process.stdout.isTTY) return;
  if (
    projects.roots.some((r) => isWithin(r, run.workspaceHost)) ||
    projects.declinedRoots.some((d) => isWithin(d, parent) && isWithin(parent, d))
  )
    return;
  if (isRootPath(parent)) return;
  try {
    assertSafeWorkspace(parent, ctx.packageRoot, run.storageRoot);
    assertSafeMapping(parent, ctx.packageRoot, run.storageRoot);
  } catch {
    return;
  }
  const answer = await select({
    message:
      'Map ' +
      parent +
      ' at every start, so other projects there (also new ones) open in the running sandbox without a restart? Agents in the sandbox can then see every project in it.',
    choices: [
      { name: 'Yes, from now on', value: 'yes' },
      { name: 'No (and do not ask again for this folder)', value: 'no' },
      { name: 'Never ask this again', value: 'never' },
    ],
  });
  if (answer === 'yes') {
    addToList(ctx, ['projects', 'roots'], parent);
    run.config.projects.roots.push(parent);
    console.log('Added ' + parent + ' to projects.roots (sandbox projects roots remove ' + parent + ' undoes it).');
    moveUnderRoot(run);
  }
  if (answer === 'no') addToList(ctx, ['projects', 'declinedRoots'], parent);
  if (answer === 'never') setSetting(ctx, ['projects', 'askToAddRoot'], false);
}

/** From now on this project is under the root's folder inside the sandbox, from this start on (one move, not two). */
function moveUnderRoot(run: ResolvedRun): void {
  const before = run.config.guestWorkspace;
  const auto = autoGuestWorkspace(run.workspaceHost);
  const derived = [auto, planMirrorWorkspace(run.workspaceHost, auto).guest];
  // In place: the caller holds run.config already.
  if (derived.some((g) => g.toLowerCase() === before.toLowerCase()))
    run.config.guestWorkspace = placeInRoot(
      run.config,
      run.workspaceHost,
      Boolean(run.mirror),
      run.notes,
    ).guestWorkspace;
  if (run.config.guestWorkspace !== before)
    console.log(
      'Inside the sandbox this project is now at ' +
        run.config.guestWorkspace +
        ' (was ' +
        before +
        '): git worktrees made at the old place need `git worktree repair` once.',
    );
}
