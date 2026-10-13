import path from 'node:path';
import { select } from '@inquirer/prompts';
import { isWithin } from '../../../shared/paths/index.js';
import type { ResolvedRun } from '../../../core/types.js';
import { assertSafeMapping, assertSafeWorkspace } from '../../../core/safe-paths.js';
import { isRootPath } from '../../../core/util/index.js';
import { type Context } from '../context.js';
import { addToList, setSetting } from '../user-config.js';

/**
 * Asked once per parent folder: map it at every start (a project root), so the projects next to this one open in the
 * running sandbox without a restart. The answer is saved to your config.
 */
export const maybeAddRoot = async (ctx: Context, run: ResolvedRun): Promise<void> => {
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
  }
  if (answer === 'no') addToList(ctx, ['projects', 'declinedRoots'], parent);
  if (answer === 'never') setSetting(ctx, ['projects', 'askToAddRoot'], false);
};
