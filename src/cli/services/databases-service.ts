// Databases of the running sandbox, through its own `sbx-db`. Returns data, never prints.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { GuestResponse } from '../../core/types.js';
import { fail } from '../../core/util/index.js';
import { SandboxChannel } from '../../host/channel/index.js';
import { insideSandbox } from '../../host/sandbox/index.js';
import type { Context } from '../commands/context.js';

export type DatabaseAction = 'list' | 'start' | 'stop';

export class DatabasesService {
  constructor(private readonly ctx: Pick<Context, 'dataPath' | 'packageRoot'>) {}

  /** Checks the action and database name from the command line. */
  validate(action: string, name: string | undefined): DatabaseAction {
    if (action !== 'list' && action !== 'start' && action !== 'stop')
      fail(
        'Unknown db action "' + action + '".',
        'Use: sandbox db  (list)  or  sandbox db start|stop <postgres|mysql|mongodb|redis|dynamodb>',
      );
    if (action !== 'list' && !name)
      fail('Which database?', 'Usage: sandbox db ' + action + ' <postgres|mysql|mongodb|redis|dynamodb>');
    return action;
  }

  /** Already inside the sandbox: runs the database tool here (its output goes to this terminal); its exit code. */
  runInside(action: DatabaseAction, name?: string): number {
    return (
      spawnSync(
        process.execPath,
        [path.join(this.ctx.packageRoot, 'dist', 'runtime', 'db.js'), action, ...(name ? [name] : [])],
        { stdio: 'inherit', windowsHide: true },
      ).status ?? 1
    );
  }

  isInsideSandbox(): boolean {
    return insideSandbox();
  }

  /** Asks the running sandbox to list, start or stop a database in the project folder `cwd` (guest path). */
  run(action: DatabaseAction, name: string | undefined, cwd: string): Promise<GuestResponse> {
    // Starting can download the database the first time.
    return new SandboxChannel(this.ctx.dataPath).exec(['sbx-db', action, ...(name ? [name] : [])], cwd, 1800);
  }

  /** Running databases by port, from `sbx-db list` (best effort: null when the sandbox does not answer). */
  async runningPorts(cwd: string): Promise<Set<number> | null> {
    try {
      const r = await new SandboxChannel(this.ctx.dataPath).exec(['sbx-db', 'list'], cwd, 30);
      return new Set(
        (r.stdout ?? '')
          .split(/\r?\n/)
          .filter((l) => /\brunning\b/.test(l))
          .map((l) => Number(/port (\d+)/.exec(l)?.[1]))
          .filter((n) => n > 0),
      );
    } catch {
      return null;
    }
  }
}
