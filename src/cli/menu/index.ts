import type { Context } from '../commands/context.js';
import { Menu } from './menu.js';

export { optionProblem } from './command-fields.js';
export { candidateFolders, severalAgentsArgv } from './several.js';

export const menu = (ctx: Context, run: (argv: string[]) => Promise<number>): Promise<number> =>
  new Menu(ctx, run).start();
