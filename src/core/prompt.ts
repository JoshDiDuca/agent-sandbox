// Questions asked on the terminal, all through @inquirer/prompts. askYesNo is for optional offers: without an
// interactive terminal the answer is "no". askRequired, askChoice and askName are for questions a command cannot go on
// without: with no terminal they fail and say how to answer on the command line.
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { fail } from './util/errors.js';

/** One entry of a list question; `description` is shown under the highlighted entry. */
export interface PromptChoice<T> {
  readonly name: string;
  readonly value: T;
  readonly description?: string;
}

/** The terminal check every required question starts with. */
function requireTerminal(fix: string): void {
  if (!process.stdin.isTTY) fail('Cannot ask here (no terminal).', fix);
}

/** A yes/no question (default no). */
export async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  return confirm({ message: question, default: defaultYes });
}

/** A yes/no question the command needs answered: no terminal fails (`--yes` answers yes on the command line). */
export async function askRequired(
  question: string,
  fix = 'Add --yes to answer yes.',
  defaultYes = false,
): Promise<boolean> {
  requireTerminal(fix);
  return confirm({ message: question, default: defaultYes });
}

/** Asks the user to type `expected` (a stronger confirmation than yes/no). */
export async function askTyped(question: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const answer = await input({ message: question + ' Type "' + expected + '" to confirm:' });
  return answer.trim().toLowerCase() === expected;
}

/** Pick one entry from a list (for an argument that was left out); `fix` says what to type instead. */
export async function askChoice<T>(message: string, choices: readonly PromptChoice<T>[], fix: string): Promise<T> {
  requireTerminal(fix);
  return select({ message, choices: [...choices] });
}

/** Tick any number of entries from a list; `fix` says what to type instead. */
export async function askChoices<T>(message: string, choices: readonly PromptChoice<T>[], fix: string): Promise<T[]> {
  requireTerminal(fix);
  return checkbox({ message, choices: [...choices] });
}

/** Type a name or a path. `validate` returns true, or the problem to show. */
export async function askName(
  message: string,
  fix: string,
  validate?: (value: string) => true | string,
): Promise<string> {
  requireTerminal(fix);
  const answer = await input({ message, validate: validate ? (v) => validate(v.trim()) : undefined });
  return answer.trim();
}
