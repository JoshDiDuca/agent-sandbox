// Questions asked on the terminal, all through @inquirer/prompts. Without an interactive terminal the answer is always "no".
import { confirm, input } from '@inquirer/prompts';

/** A yes/no question (default no). */
export const askYesNo = async (question: string, defaultYes = false): Promise<boolean> => {
  if (!process.stdin.isTTY) return false;
  return confirm({ message: question, default: defaultYes });
};

/** Asks the user to type `expected` (a stronger confirmation than yes/no). */
export const askTyped = async (question: string, expected: string): Promise<boolean> => {
  if (!process.stdin.isTTY) return false;
  const answer = await input({ message: question + ' Type "' + expected + '" to confirm:' });
  return answer.trim().toLowerCase() === expected;
};
