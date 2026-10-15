// What every run function gets: the program's context (settings, storage folder, data folder, the parsed command
// line), the same object the commands and services use. implement() is bound to it here once.
import type { Context } from '../cli/commands/context.js';
import type { TypedConfirm } from '../cli/commands/shared-use.js';
import { implementer, type OperationIO } from './kernel/index.js';

export type AppContext = Context;

/** Attaches a run function to a definition: `implement(def, async (ctx, input, io) => output)`. */
export const implement = implementer<AppContext>();

/** Another user's sandbox asks for their name to be typed: through `io`, so every surface can ask it. */
export function typedConfirm(io: OperationIO): TypedConfirm {
  return (prompt, expected) =>
    io.confirm({
      title: prompt,
      typed: expected,
      danger: true,
      noTerminal: { message: prompt + ' It was not stopped.', fix: 'In a script, add --yes to do it anyway.' },
    });
}
