// Shared plumbing for the toolchain installers. Everything lives in C:\AgentData\tools (persistent), so only the first
// boot downloads; later boots only put things on PATH.
import path from 'node:path';
import { execOutput } from '../runtime/process.js';
import { toolsDir } from '../runtime/paths.js';

/** What the toolchains contribute to the agent's environment. */
export interface ToolEnv {
  vars: Record<string, string>;
  prepend: string[];
  append: string[];
  summary: string[];
}
export const emptyEnv = (): ToolEnv => ({ vars: {}, prepend: [], append: [], summary: [] });

export const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
export const tool = (...parts: string[]): string => path.join(toolsDir, ...parts);

/** First x.y.z in a tool's `--version` output. */
export const versionOf = (exe: string, args: string[] = ['--version'], options = {}): string =>
  /\d+\.\d+\.\d+\S*/.exec(execOutput(exe, args, options))?.[0] ?? 'installed';
