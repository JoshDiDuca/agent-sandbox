import type { Config, DatabasePlan, GitAccess } from '../../core/types.js';
import type { ToolEnv } from './tool-env.js';

/** apps: the boot only (apps are machine-wide; a project that joins later shares them). */
export interface ToolchainOptions {
  gitEnabled: boolean;
  gitAccess: GitAccess;
  hostGit: boolean;
  refresh: boolean;
  databases: DatabasePlan[];
  apps?: Config['apps'];
}

/** One installer the scheduler runs: a toolchain, the apps, or a database server. */
export interface ToolchainStep {
  readonly name: string;
  readonly enabled: boolean;
  /** Steps that finish first (they are earlier in the plan). */
  readonly after?: readonly string[];
  /**
   * The step's effect is machine-wide and the same for every project (an installer, a registry entry, a shortcut, the
   * git guard): a project added after boot reuses what the boot's run contributed instead of running it again.
   */
  readonly shared?: boolean;
  install(env: ToolEnv): Promise<void> | void;
}
