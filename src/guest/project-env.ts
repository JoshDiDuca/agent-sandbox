// Pure (no guest state): the environment a project that joined after boot starts from. Kept apart from boot-env.ts,
// which reads the guest's session, so the host-side tests can import it.
import { z } from 'zod';

const Env = z.object({ vars: z.record(z.string(), z.string()), prepend: z.array(z.string()), append: z.array(z.string()), summary: z.array(z.string()) });
export const BootEnv = z.object({
  basePath: z.string(), toolVars: z.array(z.string()), steps: z.record(z.string(), Env),
  /** The boot's tool summary and LAN state, for the agent guide that lists every project. */
  summary: z.array(z.string()), lan: z.enum(['blocked', 'open', 'offline']),
});
export type BootEnvT = z.output<typeof BootEnv>;

/** Variables the boot set for its own project (its workspace, its toolchains): never inherited by another project. */
const PROJECT_VARS = /^(AGENT_WORKSPACE|AGENT_PROJECT|AGENT_SANDBOX_WORKSPACE|AGENT_PROJECT_FILE|CARGO_TARGET_DIR|VIRTUAL_ENV)$/i;

/** The environment a later project starts from: the daemon's own, without the boot project's toolchains. */
export const baseEnvFor = (boot: BootEnvT | null, current: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  if (!boot) return { ...current };
  const drop = new Set(boot.toolVars.map((v) => v.toLowerCase()));
  // Windows spells it Path; a plain object would keep both spellings.
  const base = Object.fromEntries(Object.entries(current).filter(([k]) => !drop.has(k.toLowerCase()) && !PROJECT_VARS.test(k) && k.toLowerCase() !== 'path'));
  return { ...base, PATH: boot.basePath };
};
