// Which definition a parsed command line runs, and its input: positional arguments and flags mapped to input fields by
// the definition's CLI hint (zod then checks them like any other input).
import { DEFINITIONS } from '../../app/features/defs.js';
import type { AnyDefinition } from '../../app/kernel/index.js';
import { fail } from '../../core/util/index.js';
import type { CliOptions } from '../args.js';
import { inputField } from './spec.js';

/** The definition a command runs: its own command, or an action of a hand-written one (`config get`). */
export function definitionFor(command: string, positionals: readonly string[]): AnyDefinition | undefined {
  return DEFINITIONS.find(
    (d) => d.cli?.name === command && (d.cli.action === undefined || d.cli.action === positionals[0]),
  );
}

/** commander's attribute name for a long flag: --keep-old -> keepOld. */
function attribute(flag: string): string {
  return flag.replace(/^--/, '').replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase());
}

/** The input a command line gives a definition (fields not on the line are left to the schema's defaults). */
export function cliInput(def: AnyDefinition, options: CliOptions): Record<string, unknown> {
  const hint = def.cli;
  if (!hint) return {};
  const positionals = hint.action ? options.positionals.slice(1) : options.positionals;
  const names = hint.positional ?? [];
  const missing = names.slice(positionals.length).filter((name) => !inputField(def, name).optional);
  if (missing.length)
    fail(
      'Missing ' + missing.join(' and ') + '.',
      'Usage: sandbox ' + [hint.name, hint.action, ...names.map((n) => '<' + n + '>')].filter(Boolean).join(' '),
    );
  const input: Record<string, unknown> = {};
  names.forEach((name, i) => {
    if (positionals[i] !== undefined) input[name] = positionals[i];
  });
  for (const [name, flag] of Object.entries(hint.flags ?? {})) {
    if (!flag) continue;
    const value =
      (flag.shownAs ? options.raw[attribute(flag.shownAs)] : undefined) ?? options.raw[attribute(flag.flag)];
    if (value !== undefined) input[name] = value;
  }
  return input;
}
