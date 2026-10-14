// `sandbox data clean`: asks, then removes the folders the targets name (DataService does the work).
import { humanBytes } from '../../../core/disk.js';
import { askTyped, askYesNo } from '../../../core/prompt.js';
import { fail } from '../../../core/util/index.js';
import { table } from '../../output/index.js';
import { DataService } from '../../services/index.js';
import { type Context } from '../context.js';

export { resolveCleanTargets, type CleanTarget } from '../../services/index.js';

export async function dataClean(ctx: Context): Promise<number> {
  const service = new DataService(ctx);
  const { targets, present: sized, totalBytes: total } = service.plan(ctx.options.positionals.slice(1));
  if (!sized.length) {
    console.log('Nothing to remove: ' + targets.map((t) => t.target).join(', ') + ' do(es) not exist.');
    return 0;
  }
  table(sized.map((t) => ['  ' + t.target, humanBytes(t.bytes), t.path]));
  for (const t of sized) if (t.warning) console.log('Warning: ' + t.target + ' ' + t.warning + '.');
  const yes = Boolean((ctx.options as { yes?: boolean }).yes);
  if (!yes) {
    const ok = sized.some((t) => t.target === 'all')
      ? await askTyped('This cannot be undone; the next sandbox starts from scratch and reinstalls everything.', 'all')
      : await askYesNo(
          'Delete ' + sized.map((t) => t.target).join(', ') + ' (' + humanBytes(total) + ')? This cannot be undone.',
        );
    if (!ok) {
      console.log('Nothing removed.' + (process.stdin.isTTY ? '' : ' Pass --yes to confirm without a prompt.'));
      return 1;
    }
  }
  const outcome = service.clean({ targets, present: sized, totalBytes: total });
  console.log(
    'Freed ' +
      humanBytes(outcome.freedBytes) +
      '. ' +
      (outcome.touchedData ? 'The next sandbox reinstalls what it needs.' : ''),
  );
  if (outcome.failed.length)
    fail(
      'Could not remove everything: ' + outcome.failed.join('; '),
      'Close programs using those folders and run the same command again.',
    );
  return 0;
}
