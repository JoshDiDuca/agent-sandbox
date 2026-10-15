import _ from 'lodash';
import type { Context } from '../commands/context.js';
import { scrubSecrets } from '../../core/schema/index.js';
import { c } from './colors.js';

/** Rows as aligned columns (the last column is not padded). */
export function tableLines(rows: readonly (readonly string[])[]): string[] {
  const widths = _.range(_.max(rows.map((r) => r.length)) ?? 0).map(
    (i) => _.max(rows.map((r) => (r[i] ?? '').length)) ?? 0,
  );
  return rows.map((row) =>
    row.map((cell, i) => (i === row.length - 1 ? cell : _.padEnd(cell, widths[i] + 2))).join(''),
  );
}

/** Prints rows as aligned columns (the last column is not padded). */
export function table(rows: readonly (readonly string[])[]): void {
  for (const line of tableLines(rows)) console.log(line);
}

/** Prints `value` as JSON when --json was given; returns whether it did. */
export function printJson(ctx: Context, value: unknown): boolean {
  // JSON.stringify leaves C1 controls (U+0080-U+009F) as they are; text from the sandbox must not reach a terminal raw.
  // Secret values of your settings (agent API keys) never appear, whatever built the value.
  if (ctx.options.json)
    console.log(
      scrubSecrets(JSON.stringify(value, null, 2), ctx.loaded.config).replace(
        /[\u0080-\u009f]/g,
        (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
      ),
    );
  return ctx.options.json;
}

/** A dim "Next: ..." line after a command: the usual thing to do now. */
export function nextStep(text: string): void {
  console.log(c.dim('Next: ' + text));
}
