// Every developer toolchain the sandbox provides. Each installer is independent: one failing never blocks the rest.
import type { GitAccess, Toolchains, ToolVersions } from '../../core/types.js';
import { mkdirp } from '../env.js';
import { emptyEnv, step, tool, type ToolEnv } from './common.js';
import { setupGit } from './git.js';
import { setupNode } from './node.js';
import { setupPython } from './python.js';
import { setupCpp, setupDotnet, setupRust } from './native.js';
import { setupBun, setupUv } from './runtimes.js';
import { setupVscode } from './vscode.js';

export type { ToolEnv } from './common.js';
export { pickNodeVersion } from './node.js';
export { pickPackageVersion } from './python.js';

export interface ToolchainOptions { gitEnabled: boolean; gitAccess: GitAccess; hostGit: boolean; refresh: boolean }

/** Provisions every enabled toolchain and returns the combined environment for the agent. */
export const setupToolchains = async (config: Toolchains, versions: ToolVersions, options: ToolchainOptions): Promise<ToolEnv> => {
  const env = emptyEnv();
  env.prepend.push(mkdirp(tool('bin')));
  const plan: [boolean, string, () => Promise<void>][] = [
    [options.gitEnabled, 'Git', () => setupGit(env, options.hostGit, options.refresh, options.gitAccess)],
    [true, 'nvm + Node ' + versions.node.spec, () => setupNode(env, versions)],
    [config.python.enabled, 'Python', () => setupPython(env, config.python, versions)],
    [config.cpp.enabled, 'C/C++ (MinGW-w64)', () => setupCpp(env)],
    [config.rust.enabled, 'Rust', () => setupRust(env, config.rust, options.refresh)],
    [config.dotnet.enabled, '.NET SDK', () => setupDotnet(env, config.dotnet, options.refresh)],
    [config.bun.enabled, 'Bun', () => setupBun(env)],
    [config.uv.enabled, 'uv', () => setupUv(env)],
    [config.vscode.enabled, 'VS Code', () => setupVscode(env, options.refresh)],
  ];
  for (const [enabled, name, work] of plan) if (enabled) await step(name, env, work);
  return env;
};
