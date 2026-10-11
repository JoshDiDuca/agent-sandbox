// Questions asked on the terminal. Without an interactive terminal the answer is always "no".
import readline from 'node:readline';

const ask = async (question: string): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim();
};

export const askYesNo = async (question: string): Promise<boolean> => {
  if (!process.stdin.isTTY) return false;
  return /^y(es)?$/i.test(await ask(question + ' [y/N] '));
};

/** Asks the user to type `expected` (a stronger confirmation than y/N). */
export const askTyped = async (question: string, expected: string): Promise<boolean> => {
  if (!process.stdin.isTTY) return false;
  return (await ask(question + ' Type "' + expected + '" to confirm: ')).toLowerCase() === expected;
};
