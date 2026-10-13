// (Beta) Agent commands: with agentCommands.enabled, typing an agent's own command on this PC (claude, codex, ...) starts
// it in a hidden sandbox for the folder you are in and attaches that terminal. Small forwarding files in
// <storage>\agent-commands go first on YOUR PATH (so they win over npm's and the installers' copies); turning it off
// removes the files and that one PATH entry. SANDBOX_AGENT_DIRECT=1 runs the real agent on this PC instead.
import path from 'node:path';
import type { Config } from '../../core/types.js';
import { fileExists } from '../../core/util/index.js';

export const commandsDir = (storageRoot: string): string => path.join(storageRoot, 'agent-commands');
const EXTENSIONS = ['.exe', '.cmd', '.bat'];

export interface AgentCommand {
  harness: string;
  command: string;
  real: string;
}

/** cmd.exe expands % and ^ even inside quotes: such paths cannot go into a forwarding file safely. */
export const cmdSafe = (p: string): boolean => !/[%"^\r\n]/.test(p);

/** The agent's own executable on this PC, skipping this tool's forwarding files. */
export const realAgent = (
  command: string,
  skipDir: string,
  pathValue = process.env.PATH ?? process.env.Path ?? '',
): string | null => {
  const skip = path.resolve(skipDir).toLowerCase();
  const dirs = pathValue.split(path.delimiter).filter((d) => d && path.resolve(d).toLowerCase() !== skip);
  for (const dir of dirs)
    for (const ext of EXTENSIONS) {
      const candidate = path.join(dir, command + ext);
      if (fileExists(candidate)) return candidate;
    }
  return null;
};

/** The agents that get a forwarding command: installed on this PC, and listed (or "auto" = all of them). */
export const agentCommands = (config: Config, storageRoot: string, pathValue?: string): AgentCommand[] => {
  const wanted = config.agentCommands.agents;
  return Object.entries(config.harnesses).flatMap(([harness, h]): AgentCommand[] => {
    if (wanted !== 'auto' && !wanted.includes(harness)) return [];
    const command = h.npmBin ?? (h.hostExecutable ? path.parse(h.hostExecutable).name : harness);
    const real = /^[A-Za-z0-9._-]+$/.test(command) ? realAgent(command, commandsDir(storageRoot), pathValue) : null;
    return real && cmdSafe(real) ? [{ harness, command, real }] : [];
  });
};
