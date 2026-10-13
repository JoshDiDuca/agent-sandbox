import { CommanderError } from 'commander';
import { c } from './output/index.js';
import { UserError, errMsg, plainText } from '../core/util/index.js';

/** Prints a problem the way a user can act on it: what happened, how to fix it; stack traces only for real bugs. */
export const report = (e: unknown): number => {
  if (e instanceof CommanderError)
    return ['commander.helpDisplayed', 'commander.help', 'commander.version'].includes(e.code) ? 0 : e.exitCode || 1;
  if (e instanceof UserError) {
    // Messages can quote what the sandbox wrote (a session's status, an address): never with its control codes.
    console.error(c.red('Error: ') + plainText(e.message));
    if (e.fix) console.error('  Fix:  ' + plainText(e.fix));
    return 1;
  }
  console.error(c.red('Unexpected error: ') + errMsg(e));
  console.error(
    c.dim(
      'This is a bug in windows-development-sandbox. Details: ' +
        (e instanceof Error && e.stack ? e.stack.split('\n').slice(1, 4).join(' | ').trim() : 'none'),
    ),
  );
  console.error('  Please report it with the output of: sandbox doctor');
  return 1;
};
