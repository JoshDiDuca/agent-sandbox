import type { Context } from '../commands/context.js';
import { Menu } from './menu.js';

export { optionProblem } from './command-fields.js';
export { candidateFolders, severalAgentsArgv } from './several.js';

export function menu(ctx: Context, run: (argv: string[]) => Promise<number>): Promise<number> {
  return new Menu(ctx, run).start();
}
