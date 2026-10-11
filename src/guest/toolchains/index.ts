// Every developer toolchain and database the sandbox provides (the list is in plan.ts). Installers run in parallel (a
// few at a time; downloads and installers do not block each other) and each is independent: one failing never blocks
// the rest. A step that needs another (Rust links with MinGW's gcc, uv installs the Python tools) waits for it.
import type { Toolchains, ToolVersions } from '../../core/types.js';
import { log, mkdirp, setSandboxStatus } from '../env.js';
import { emptyEnv, step, tool, type ToolEnv } from './common.js';
import { plan, type Step, type ToolchainOptions } from './plan.js';

export type { ToolEnv } from './common.js';
export type { ToolchainOptions } from './plan.js';

/** How many installers run at once: enough to overlap downloads with installs, few enough not to thrash the disk. */
const PARALLEL = 4;

/** Runs the steps (each with its own environment) at most PARALLEL at a time, after the steps they depend on. */
const runSteps = async (steps: Step[]): Promise<Map<string, ToolEnv>> => {
  const envs = new Map(steps.map((s) => [s.name, emptyEnv()]));
  const finished = new Map<string, Promise<void>>();
  const running = new Set<string>();
  const waiting: (() => void)[] = [];
  let done = 0;
  const report = (): void => { if (running.size) setSandboxStatus('provisioning', 'Installing ' + [...running].join(', ') + ' (' + done + ' of ' + steps.length + ' done)'); };
  for (const s of steps) {
    // Dependencies first (they are earlier in the plan, so their promises exist), then a free slot.
    finished.set(s.name, (async () => {
      await Promise.all((s.after ?? []).map((name) => finished.get(name)));
      while (running.size >= PARALLEL) await new Promise<void>((r) => waiting.push(r));
      running.add(s.name);
      report();
      try { await step(s.name, envs.get(s.name)!, async () => s.run(envs.get(s.name)!)); } finally {
        running.delete(s.name);
        done++;
        report();
        waiting.shift()?.();
      }
    })());
  }
  await Promise.all(finished.values());
  return envs;
};

/** Provisions every enabled toolchain and database, and returns the combined environment for the agent. */
export const setupToolchains = async (config: Toolchains, versions: ToolVersions, options: ToolchainOptions): Promise<ToolEnv> => {
  const steps = plan(config, versions, options).filter((s) => s.on);
  const envs = await runSteps(steps);
  // Merged in plan order, so PATH order never depends on which download finished first.
  const env = emptyEnv();
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
