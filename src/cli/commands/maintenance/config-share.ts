// `sandbox config export` and `import`: your settings as a shareable .json, and a shared file read back in.
import fs from 'node:fs';
import path from 'node:path';
import { askRequired } from '../../../core/prompt.js';
import { fail, safeText, writeJson } from '../../../core/util/index.js';
import { c } from '../../output/index.js';
import {
  ConfigFile,
  diffText,
  exportSettings,
  planImport,
  skippedLine,
  type ImportPlan,
} from '../../menu/settings/index.js';
import type { Context } from '../context.js';

/** The file `config export` writes when none is named. */
export const DEFAULT_EXPORT = 'sandbox-settings.json';

/** A shared file is a few KB; anything bigger is not one. */
const MAX_BYTES = 1024 * 1024;

/** Writes the settings that differ from the defaults (no secrets, no storage, no paths unless asked) to `file`. */
export function writeExport(ctx: Context, file: string, withPaths: boolean, overwrite: boolean): string[] {
  const target = path.resolve(file);
  if (!overwrite && fs.existsSync(target)) fail(target + ' exists already.', 'Pick another name, or delete it first.');
  const { data, skipped } = exportSettings(ctx.loaded.config, withPaths);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeJson(target, data);
  return skipped.map(skippedLine);
}

/** Reads a shared file and plans the import. Fails with the reason when it cannot be read. */
export function readImport(ctx: Context, file: string): ImportPlan {
  const source = path.resolve(file);
  if (!fs.existsSync(source))
    fail('There is no file ' + source + '.', 'Give the path of a file made by sandbox config export.');
  if (fs.statSync(source).size > MAX_BYTES) fail(source + ' is too big to be a settings file.');
  const plan = planImport(fs.readFileSync(source, 'utf8'), ctx.loaded.config);
  if (plan.problems.length)
    fail(
      source + ' is not valid settings:\n  ' + plan.problems.map(safeText).join('\n  '),
      'Nothing was changed. Fix the file, or export a new one with: sandbox config export',
    );
  return plan;
}

/** Writes the planned changes to your settings file (comments stay); returns how many settings changed. */
export function applyImport(ctx: Context, plan: ImportPlan): number {
  const outcome = ConfigFile.user(ctx.loaded.configPath).setMany(plan.changes);
  if (typeof outcome === 'object')
    fail('Could not import: ' + outcome.problems.join('; '), 'Nothing was written. Your settings are unchanged.');
  return plan.changes.length;
}

export function exportCommand(ctx: Context, file: string | undefined): number {
  const target = file ?? DEFAULT_EXPORT;
  const skipped = writeExport(ctx, target, ctx.options.withPaths, false);
  console.log('Wrote ' + path.resolve(target) + ' (only what differs from the defaults).');
  if (skipped.length) {
    console.log('Left out:');
    for (const line of skipped) console.log('  ' + line);
  }
  if (!ctx.options.withPaths && skipped.some((s) => s.includes('folder or file')))
    console.log("Keep this PC's folders and files in the file with --with-paths.");
  return 0;
}

export async function importCommand(ctx: Context, file: string | undefined): Promise<number> {
  if (!file) fail('Which file?', 'Usage: sandbox config import <file>');
  const plan = readImport(ctx, file);
  if (plan.skipped.length) {
    console.log('Not imported (never taken from a file):');
    for (const s of plan.skipped) console.log('  ' + safeText(skippedLine(s)));
  }
  if (!plan.changes.length) {
    console.log('Nothing to change: your settings already match the file.');
    return 0;
  }
  console.log('This would change ' + plan.changes.length + ' setting' + (plan.changes.length === 1 ? '' : 's') + ':');
  for (const line of diffText(plan.lines)) console.log('  ' + safeText(line));
  const yes =
    ctx.options.yes ||
    (await askRequired('Change your settings like this?', 'Add --yes to change them without asking.'));
  if (!yes) {
    console.log('Nothing was changed.');
    return 0;
  }
  const n = applyImport(ctx, plan);
  console.log(c.green('Imported ' + n + ' setting' + (n === 1 ? '' : 's') + '.') + ' New sandboxes use them.');
  return 0;
}
