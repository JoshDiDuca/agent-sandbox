// Checks what the user typed before anything starts, so a typo fails at once with the list of valid values
// instead of halfway into a sandbox boot. Pure helpers first, then validateOptions (the one call from the dispatcher).
import fs from 'node:fs';
import path from 'node:path';
import { DATABASES } from '../core/detect-databases.js';
import { fail } from '../core/util.js';
import { listAccounts } from '../host/accounts.js';
import type { CliOptions } from './args.js';
import type { Context } from './commands/context.js';

/** Edit distance, for "did you mean". */
export const distance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
};

/** The closest of `choices` to `input`, when it is close enough to be a typo. */
export const closest = (input: string, choices: readonly string[]): string | undefined => {
  const best = choices.map((c) => ({ c, d: distance(input.toLowerCase(), c.toLowerCase()) })).sort((x, y) => x.d - y.d)[0];
  return best && best.d <= Math.max(2, Math.floor(input.length / 3)) ? best.c : undefined;
};

/** "Unknown agent "cluade". Did you mean claude?" with the valid values as the fix. */
export const unknownValue = (what: string, input: string, choices: readonly string[], howToList: string): never => {
  const hint = closest(input, choices);
  return fail('Unknown ' + what + ' "' + input + '".' + (hint ? ' Did you mean ' + hint + '?' : ''), (choices.length ? 'Choose one of: ' + choices.join(', ') + '. ' : '') + howToList);
};

/** Node: 22, 22.1, v22.1.0, lts, lts/*, lts/iron, latest, current, node. */
export const validNodeSpec = (spec: string): boolean => /^(v?\d+(\.\d+){0,2}|node|latest|current|stable|lts(\/(\*|[a-z]+))?)$/i.test(spec.trim());
/** Python 3: 3, 3.12, 3.12.4. */
export const validPythonSpec = (spec: string): boolean => /^v?3(\.\d+){0,2}$/.test(spec.trim());

export const checkHarness = (name: string | undefined, harnesses: string[]): void => {
  if (name !== undefined && !harnesses.includes(name)) unknownValue('agent', name, harnesses, 'Add your own under "harnesses" in your settings (sandbox config).');
};

/** Commands that read these options; checked only for them (restart/doctor take --harness too). */
const LAUNCHING = new Set(['launch', 'generate', 'host-claude']);

/** Fails with what is wrong and what is valid, before anything is started. */
export const validateOptions = (ctx: Context): void => {
  const o: CliOptions = ctx.options;
  const harnesses = Object.keys(ctx.loaded.config.harnesses);
  if (['launch', 'generate', 'restart', 'doctor'].includes(o.command)) checkHarness(o.harness, harnesses);
  if (!LAUNCHING.has(o.command)) return;
  if (o.node !== undefined && !validNodeSpec(o.node)) fail('"' + o.node + '" is not a Node version.', 'Use a number like 22 or 22.11.0, or lts, latest.');
  if (o.python !== undefined && !validPythonSpec(o.python)) fail('"' + o.python + '" is not a Python 3 version.', 'Use 3, 3.12 or 3.12.4.');
  for (const db of o.databases.flatMap((d) => d.split(',')).map((d) => d.trim()).filter(Boolean)) {
    if (!(DATABASES as readonly string[]).includes(db)) unknownValue('database', db, DATABASES, 'Repeat --database for several.');
  }
  if (o.account !== undefined) {
    const names = listAccounts(ctx.storageRoot, ctx.dataPath).map((a) => a.name);
    if (!names.includes(o.account)) unknownValue('account', o.account, names, names.length ? 'See them with: sandbox account list' : 'None saved yet: sign in inside the sandbox, then run sandbox account save <name>.');
  }
  if (o.workspace !== undefined && !fs.existsSync(path.resolve(o.workspace))) fail('The folder ' + path.resolve(o.workspace) + ' does not exist.', 'Check the --workspace path (or leave it out to use the current folder).');
  for (const script of o.scripts) if (!fs.existsSync(path.resolve(script))) fail('The script ' + path.resolve(script) + ' does not exist.', 'Check the --script path.');
};
