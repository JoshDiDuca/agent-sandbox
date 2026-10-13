import type { Config, DatabasePlan, GitAccess } from '../../core/types.js';
import { type ToolEnv } from './tool-env.js';

/** apps: the boot only (apps are machine-wide; a project that joins later shares them). */
export interface ToolchainOptions {
  gitEnabled: boolean;
  gitAccess: GitAccess;
  hostGit: boolean;
  refresh: boolean;
  databases: DatabasePlan[];
  apps?: Config['apps'];
}

/**
 * shared: the step's effect is machine-wide and the same for every project (an installer, a registry entry, a
 * shortcut, the git guard). A project added after boot reuses what the boot's run contributed instead of running it
 * again under the sessions that already use it.
 */
export interface Step {
  name: string;
  on: boolean;
  after?: string[];
  shared?: boolean;
  run: (env: ToolEnv) => Promise<void> | void;
}
