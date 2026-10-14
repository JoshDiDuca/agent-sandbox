// Where the per-machine state of an all-users install lives: %ProgramData%\AgentSandbox (AGENT_SANDBOX_MACHINE_HOME
// overrides it in tests), and the folder of one record per running sandbox below it.
import path from 'node:path';
import { machineRoot } from '../../core/config/index.js';

export { machineRoot };

/** The shared tree: one storage folder per user. Only folders in it are ever opened to the group. */
export function usersDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(machineRoot(env), 'users');
}

/** Records of the sandboxes that are running: one <sid>.json per Windows user who started one. */
export function activeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(machineRoot(env), 'active');
}
