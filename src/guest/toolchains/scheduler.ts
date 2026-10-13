// Runs the planned steps in parallel, a few at a time, after the steps they depend on. One lock per kind of step is
// held across runs: the boot and projects that join later never install two Nodes (or two Gos) at once.
import { warn } from '../runtime/log.js';
import { setSandboxStatus } from '../runtime/status.js';
import { errMsg } from '../../core/util/errors.js';
import { emptyEnv, type ToolEnv } from './tool-env.js';
import type { ToolchainStep } from './step.js';

/** How many installers run at once: enough to overlap downloads with installs, few enough not to thrash the disk. */
const PARALLEL = 4;

export interface RunOptions {
  /** Progress lines ("Installing Go, Rust (3 of 9 done)"); default: the sandbox's boot status. */
  report?: (message: string) => void;
  /** What machine-wide (shared) steps contributed at boot: reused instead of run again. */
  reuse?: Record<string, ToolEnv>;
}

/** Runs one installer; a failure is reported and skipped so it never blocks the other toolchains. */
async function runReported(name: string, env: ToolEnv, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (e) {
    warn(
      name +
        ' could not be set up and is skipped; everything else still works, and the next start tries again. Reason: ' +
        errMsg(e),
    );
    env.summary.push(name + ': FAILED');
  }
}

export class StepScheduler {
  /** One lock per kind of step ("Node 20" and "Node 22" share nvm's folders): held while that step runs, in any run. */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly parallel = PARALLEL) {}

  /** Runs the steps (each with its own environment) and returns each step's environment, in plan order. */
  async run(steps: readonly ToolchainStep[], o: RunOptions): Promise<Map<string, ToolEnv>> {
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
          const env = envs.get(s.name)!;
          const reused = s.shared ? o.reuse?.[s.name] : undefined;
          if (reused) {
            envs.set(s.name, structuredClone(reused));
            done++;
            return;
          }
          while (running.size >= this.parallel) await new Promise<void>((r) => waiting.push(r));
          running.add(s.name);
          report();
          try {
            await this.exclusive(s.name, () => runReported(s.name, env, async () => s.install(env)));
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
  }

  /** Runs `work` once no other step of the same kind (first word of the name) is running. */
  private async exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
    const key = name.split(' ')[0].toLowerCase();
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const chained = previous.then(() => mine);
    this.locks.set(key, chained);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }
}

/** The one scheduler: its locks span the boot's run and every project's run. */
export const scheduler = new StepScheduler();
