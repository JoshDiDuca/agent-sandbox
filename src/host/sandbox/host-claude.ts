import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { refuseInSelfTest } from '../test-guard.js';
import { agentCommands, commandsDir, realAgent } from '../agent-commands/index.js';
import type { Config } from '../../core/types.js';
import { ensureDir, fail } from '../../core/util/index.js';

/** Runs any agent's own program on this PC, NOT sandboxed (`sandbox host <agent>`). */
export const hostAgent = (
  config: Config,
  storageRoot: string,
  agent: string,
  personal: boolean,
  args: string[],
): number => {
  if (agent === 'claude') return hostClaude(storageRoot, personal, args);
  refuseInSelfTest('run an agent on this PC');
  // Every installed agent, whatever agentCommands.agents lists; never this tool's own forwarding files.
  const all: Config = { ...config, agentCommands: { ...config.agentCommands, agents: 'auto' } };
  const found = agentCommands(all, storageRoot).find((a) => a.harness === agent);
  if (!found)
    fail(
      agent in config.harnesses
        ? agent + ' is not installed on this PC (its command is not on PATH).'
        : 'Unknown agent "' + agent + '".',
      'Install it on this PC first, or start it in the sandbox with: sandbox ' + agent,
    );
  const env: NodeJS.ProcessEnv = { ...process.env, SANDBOX_AGENT_DIRECT: '1' };
  console.warn(agent + ' on this PC is NOT sandboxed.');
  const result = found.real.toLowerCase().endsWith('.cmd')
    ? spawnSync(SYSTEM.cmd(), ['/d', '/c', found.real, ...args], { stdio: 'inherit', env })
    : spawnSync(found.real, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

export const hostClaude = (storageRoot: string, personal: boolean, args: string[]): number => {
  refuseInSelfTest('run Claude Code on this PC');
  // Never this tool's own forwarding command (agentCommands), which would start a sandbox instead.
  const exe = realAgent('claude', commandsDir(storageRoot));
  if (!exe)
    fail(
      'Claude Code is not installed on this PC (no claude.exe or claude.cmd on PATH).',
      'Install it: npm install -g @anthropic-ai/claude-code',
    );
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!personal) {
    const profile = path.join(storageRoot, 'host', 'claude');
    ensureDir(profile);
    env.CLAUDE_CONFIG_DIR = profile;
    console.warn(
      'Host Claude is NOT sandboxed. Using separate profile: ' + profile + ' (pass --personal to use your normal one).',
    );
  }
  const result = exe.toLowerCase().endsWith('.cmd')
    ? spawnSync(SYSTEM.cmd(), ['/d', '/c', exe, ...args], { stdio: 'inherit', env })
    : spawnSync(exe, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  return result.status ?? 1;
};
