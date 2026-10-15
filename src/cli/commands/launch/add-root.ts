import path from 'node:path';
import { select } from '@inquirer/prompts';
import { isWithin, planMirrorWorkspace } from '../../../shared/paths/index.js';
import type { ResolvedRun } from '../../../core/types.js';
import { assertSafeMapping, assertSafeWorkspace } from '../../../core/safe-paths.js';
import { isRootPath } from '../../../core/util/index.js';
import { autoGuestWorkspace, placeInRoot } from '../../../core/run/index.js';
import { c } from '../../output/index.js';
import { type Context } from '../context.js';
import { addToList, setSetting } from '../user-config.js';

/**
 * Asked at a start from a folder whose parent is not shared yet ("Not now" asks again next time): map it at every
 * start (a project root), so the projects next to this one open in the running sandbox without a restart. The answer is
 * saved to your config.
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
      'Share all projects in ' +
      parent +
      ' with the sandbox?\n  ' +
      c.dim('Projects there, also new ones, then open without a restart. Agents can see every one of them.'),
    choices: [
      { name: 'Yes, share ' + parent, value: 'yes' },
      { name: 'Not now', value: 'no' },
      { name: 'No, and stop asking', value: 'never' },
    ],
  });
  if (answer === 'yes') {
    addToList(ctx, ['projects', 'roots'], parent);
    run.config.projects.roots.push(parent);
    console.log('Added ' + parent + '. Undo: sandbox projects roots remove ' + parent);
    moveUnderRoot(run);
  }
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
