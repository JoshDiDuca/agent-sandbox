// Every developer toolchain and database the sandbox provides (the list is in plan.ts). Installers run in parallel (a
// few at a time; downloads and installers do not block each other) and each is independent: one failing never blocks
// the rest. A step that needs another (Rust links with MinGW's gcc, uv installs the Python tools) waits for it.
// The boot runs it once for the launch folder; the session daemon runs it again for each project registered later,
// possibly several at once, so the same kind of step (two Node installs, two Go installs) never runs twice at a time.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Toolchains, ToolVersions } from '../../core/types.js';
import { watchDownloads } from '../../shared/download.js';
import { log, mkdirp, setSandboxStatus } from '../env.js';
import { emptyEnv, step, tool, type ToolEnv } from './common.js';
import { plan, type Step, type ToolchainOptions } from './plan.js';

export type { ToolEnv } from './common.js';
export type { ToolchainOptions } from './plan.js';

/** How many installers run at once: enough to overlap downloads with installs, few enough not to thrash the disk. */
const PARALLEL = 4;

/** The step a download belongs to (several run at once), for its progress. */
const currentStep = new AsyncLocalStorage<string>();

/** One lock per kind of step ("Node 20" and "Node 22" share nvm's folders): held while that step runs, in any run. */
const locks = new Map<string, Promise<void>>();
const lockKey = (name: string): string => name.split(' ')[0].toLowerCase();
const exclusive = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
  const key = lockKey(name);
  const previous = locks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const mine = new Promise<void>((r) => { release = r; });
  const chained = previous.then(() => mine);
  locks.set(key, chained);
  await previous;
  try { return await work(); } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
};

export interface RunOptions {
  /** Progress lines ("Installing Go, Rust (3 of 9 done)"); default: the sandbox's boot status. */
  report?: (message: string) => void;
  /** What machine-wide (shared) steps contributed at boot: reused instead of run again. */
  reuse?: Record<string, ToolEnv>;
}

/** Runs the steps (each with its own environment) at most PARALLEL at a time, after the steps they depend on. */
const runSteps = async (steps: Step[], o: RunOptions): Promise<Map<string, ToolEnv>> => {
  const envs = new Map(steps.map((s) => [s.name, emptyEnv()]));
  const finished = new Map<string, Promise<void>>();
  const running = new Set<string>();
  const waiting: (() => void)[] = [];
  let done = 0;
  // The boot (no `report`) also publishes structured progress: what runs now, how far its download is, how many are done.
  const percent = new Map<string, number>();
  const active = () => [...running].map((name) => ({ name, ...(percent.has(name) ? { percent: percent.get(name)! } : {}) }));
  const say = o.report ?? ((message: string) => setSandboxStatus('provisioning', message, { active: active(), done, total: steps.length }));
  const report = (): void => { if (running.size) say('Installing ' + [...running].join(', ') + ' (' + done + ' of ' + steps.length + ' done)'); };
  if (!o.report) watchDownloads(() => {
    const name = currentStep.getStore();
    return name ? (fraction) => { percent.set(name, Math.round(fraction * 100)); report(); } : null;
  });
  for (const s of steps) {
    // Dependencies first (they are earlier in the plan, so their promises exist), then a free slot.
    finished.set(s.name, (async () => {
      await Promise.all((s.after ?? []).map((name) => finished.get(name)));
      const reused = s.shared ? o.reuse?.[s.name] : undefined;
      if (reused) { envs.set(s.name, structuredClone(reused)); done++; return; }
      while (running.size >= PARALLEL) await new Promise<void>((r) => waiting.push(r));
      running.add(s.name);
      report();
      try { await currentStep.run(s.name, () => exclusive(s.name, () => step(s.name, envs.get(s.name)!, async () => s.run(envs.get(s.name)!)))); } finally {
        running.delete(s.name);
        percent.delete(s.name);
        done++;
        report();
        waiting.shift()?.();
      }
    })());
  }
  try { await Promise.all(finished.values()); } finally { if (!o.report) watchDownloads(null); }
  if (!o.report) setSandboxStatus('provisioning', 'Set up ' + steps.length + ' toolchains and databases', { active: [], done, total: steps.length });
  return envs;
};

/** The combined environment, plus what each step contributed (the boot keeps it so later projects can reuse shared steps). */
export interface ToolchainResult extends ToolEnv { steps: Record<string, ToolEnv> }

/** Provisions every enabled toolchain and database, and returns the combined environment for the agent. */
export const setupToolchains = async (config: Toolchains, versions: ToolVersions, options: ToolchainOptions, run: RunOptions = {}): Promise<ToolchainResult> => {
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
