// Every developer toolchain and database the sandbox provides (the list is in plan.ts). Installers run in parallel (a
// few at a time; downloads and installers do not block each other) and each is independent: one failing never blocks
// the rest. A step that needs another (Rust links with MinGW's gcc, uv installs the Python tools) waits for it.
// The boot runs it once for the launch folder; the session daemon runs it again for each project registered later,
// possibly several at once, so the same kind of step (two Node installs, two Go installs) never runs twice at a time.
import type { Toolchains, ToolVersions } from '../../core/types.js';
import { log } from '../runtime/log.js';
import { mkdirp } from '../runtime/fs.js';
import { emptyEnv, tool, type ToolEnv } from './tool-env.js';
import { plan } from './plan.js';
import { type ToolchainOptions } from './step.js';
import { type RunOptions, runSteps } from './scheduler.js';

export type { ToolEnv } from './tool-env.js';
export type { ToolchainOptions } from './step.js';

/** The combined environment, plus what each step contributed (the boot keeps it so later projects can reuse shared steps). */
export interface ToolchainResult extends ToolEnv {
  steps: Record<string, ToolEnv>;
}

/** Provisions every enabled toolchain and database, and returns the combined environment for the agent. */
export const setupToolchains = async (
  config: Toolchains,
  versions: ToolVersions,
  options: ToolchainOptions,
  run: RunOptions = {},
): Promise<ToolchainResult> => {
  const steps = plan(config, versions, options).filter((s) => s.on);
  const envs = await runSteps(steps, run);
  // Merged in plan order, so PATH order never depends on which download finished first.
  const env: ToolchainResult = { ...emptyEnv(), steps: Object.fromEntries(envs) };
  env.prepend.push(mkdirp(tool('bin')));
  for (const part of envs.values()) {
    Object.assign(env.vars, part.vars);
    env.prepend.push(...part.prepend);
    env.append.push(...part.append);
    env.summary.push(...part.summary);
  }
  Object.assign(env.vars, config.environment);
  log('Set up ' + steps.length + ' toolchains and databases.');
  return env;
};
