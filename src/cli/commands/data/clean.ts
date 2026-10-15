// `sandbox data clean`: asks, then removes the folders the targets name (DataService does the work).
import { humanBytes } from '../../../core/disk.js';
import { askChoices, askRequired, askTyped } from '../../../core/prompt.js';
import { fail } from '../../../core/util/index.js';
import { nextStep, table, working } from '../../output/index.js';
import { DataService } from '../../services/index.js';
import { type Context } from '../context.js';
import { cleanTargetOf } from './collect.js';

export { resolveCleanTargets, type CleanTarget } from '../../services/index.js';

/** No target typed: a list of what can be cleaned, with sizes, to tick from (a terminal is needed). */
async function pickTargets(service: DataService): Promise<string[]> {
  const fix = 'Name them: sandbox data clean logs tools/go   (what exists: sandbox data)';
  if (!process.stdin.isTTY) fail('Which data should be cleaned?', fix);
  const rows = await working('Measuring the saved data (big folders take a moment)', () => service.entries());
  const choices = rows.flatMap((e) => {
    const target = cleanTargetOf(e);
    return target ? [{ name: target.padEnd(28) + humanBytes(e.bytes), value: target }] : [];
  });
  if (!choices.length) return [];
  return askChoices('What do you want to delete? (space ticks, enter confirms)', choices, fix);
}

export async function dataClean(ctx: Context): Promise<number> {
  const service = new DataService(ctx);
  const typed = ctx.options.positionals.slice(1);
  const inputs = typed.length ? typed : await pickTargets(service);
  if (!inputs.length) {
    console.log('Nothing chosen, nothing removed.');
    return 0;
  }
  const { targets, present: sized, totalBytes: total } = service.plan(inputs);
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
      : await askRequired(
          'Delete ' + sized.map((t) => t.target).join(', ') + ' (' + humanBytes(total) + ')? This cannot be undone.',
          'Add --yes to delete without asking.',
        );
    if (!ok) {
      console.log('Nothing removed.');
      return 1;
    }
  }
  const outcome = service.clean({ targets, present: sized, totalBytes: total });
  if (outcome.failed.length)
    fail(
      'Could not remove everything: ' + outcome.failed.join('; '),
      'Close programs using those folders and run the same command again.',
    );
  console.log(
    'Removed ' +
      sized.map((t) => t.target).join(', ') +
      ' and freed ' +
      humanBytes(outcome.freedBytes) +
      (outcome.touchedData ? '; the next sandbox reinstalls what it needs.' : '.'),
  );
  nextStep('sandbox data   (see what is left)');
  return 0;
}
