// One database server in the sandbox: started by the boot (or sbx-db start), stopped by sbx-db stop.
import { spawnSync } from 'node:child_process';
import type { DatabasePlan } from '../../core/types.js';
import { SYSTEM } from '../../shared/system.js';
import type { ToolEnv } from '../toolchains/tool-env.js';
import { DATABASE_NAMES, type ServedDatabase } from './names.js';

/** The process listening on a local TCP port (netstat: no PowerShell start-up cost), or null. */
function listenerPid(port: number): number | null {
  const out = spawnSync(SYSTEM.netstat(), ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  const hit = out
    .split(/\r?\n/)
    .map((l) => /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(l))
    .find((m) => m && Number(m[1]) === port);
  return hit ? Number(hit[2]) : null;
}

/** Ends the processes listening on a database's port and its admin UI's port. */
export function killListeners(plan: DatabasePlan): void {
  for (const port of [plan.port, plan.adminPort ?? 0]) {
    const pid = port && listenerPid(port);
    if (pid)
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
  }
}

export abstract class DatabaseServer {
  abstract readonly id: ServedDatabase;

  get label(): string {
    return DATABASE_NAMES[this.id];
  }

  /** Installs the server once, creates its data folder once, starts it, and adds its variables and tools to `env`. */
  abstract start(env: ToolEnv, plan: DatabasePlan): Promise<void>;

  /** Ends whatever listens on the server's port (and its admin UI's port). */
  async stop(plan: DatabasePlan): Promise<void> {
    killListeners(plan);
  }
}
