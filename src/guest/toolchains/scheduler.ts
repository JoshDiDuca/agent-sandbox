import { setSandboxStatus } from '../runtime/status.js';
import { emptyEnv, type ToolEnv } from './tool-env.js';
import { step } from './install.js';
import { type Step } from './step.js';

/** How many installers run at once: enough to overlap downloads with installs, few enough not to thrash the disk. */
const PARALLEL = 4;

/** One lock per kind of step ("Node 20" and "Node 22" share nvm's folders): held while that step runs, in any run. */
const locks = new Map<string, Promise<void>>();
const lockKey = (name: string): string => name.split(' ')[0].toLowerCase();
const exclusive = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
  const key = lockKey(name);
  const previous = locks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const chained = previous.then(() => mine);
  locks.set(key, chained);
  await previous;
  try {
    return await work();
  } finally {
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
export const runSteps = async (steps: Step[], o: RunOptions): Promise<Map<string, ToolEnv>> => {
  const envs = new Map(steps.map((s) => [s.name, emptyEnv()]));
  const finished = new Map<string, Promise<void>>();
  const running = new Set<string>();
  const waiting: (() => void)[] = [];
  let done = 0;
  const say = o.report ?? ((message: string) => setSandboxStatus('provisioning', message));
  const report = (): void => {
    if (running.size) say('Installing ' + [...running].join(', ') + ' (' + done + ' of ' + steps.length + ' done)');
  };
  for (const s of steps) {
    // Dependencies first (they are earlier in the plan, so their promises exist), then a free slot.
    finished.set(
      s.name,
      (async () => {
        await Promise.all((s.after ?? []).map((name) => finished.get(name)));
        const reused = s.shared ? o.reuse?.[s.name] : undefined;
        if (reused) {
          envs.set(s.name, structuredClone(reused));
          done++;
          return;
        }
        while (running.size >= PARALLEL) await new Promise<void>((r) => waiting.push(r));
        running.add(s.name);
        report();
        try {
          await exclusive(s.name, () => step(s.name, envs.get(s.name)!, async () => s.run(envs.get(s.name)!)));
        } finally {
          running.delete(s.name);
          done++;
          report();
          waiting.shift()?.();
        }
      })(),
    );
  }
  await Promise.all(finished.values());
  return envs;
};
