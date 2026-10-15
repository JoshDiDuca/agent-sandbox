import _ from 'lodash';
import type { Context } from '../commands/context.js';
import { c } from './colors.js';

/** Prints rows as aligned columns (the last column is not padded). */
export function table(rows: string[][]): void {
  const widths = _.range(_.max(rows.map((r) => r.length)) ?? 0).map(
    (i) => _.max(rows.map((r) => (r[i] ?? '').length)) ?? 0,
  );
  for (const row of rows)
    console.log(row.map((cell, i) => (i === row.length - 1 ? cell : _.padEnd(cell, widths[i] + 2))).join(''));
}

/** Prints `value` as JSON when --json was given; returns whether it did. */
export function printJson(ctx: Context, value: unknown): boolean {
  // JSON.stringify leaves C1 controls (U+0080-U+009F) as they are; text from the sandbox must not reach a terminal raw.
  if (ctx.options.json)
    console.log(
      JSON.stringify(value, null, 2).replace(
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
