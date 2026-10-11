// Every developer toolchain the sandbox provides. Each installer is independent: one failing never blocks the rest.
import type { GitAccess, Toolchains, ToolVersions } from '../../core/types.js';
import { exec, exists, mkdirp } from '../env.js';
import { emptyEnv, installOnce, step, tool, wanted, type ToolEnv } from './common.js';
import { setupGit } from './git.js';
import { setupGo } from './go.js';
import { setupJava } from './java.js';
import { setupNode } from './node.js';
import { setupPython } from './python.js';
import { setupCpp, setupDotnet, setupMesa, setupRust } from './native.js';
import { setupBun, setupDeno, setupUv } from './runtimes.js';
import { setupPhp, setupRuby, setupVcRuntime } from './scripting.js';
import { setupVscode } from './vscode.js';

export type { ToolEnv } from './common.js';
export { pickNodeVersion, pickPackageVersion } from './versions.js';

export interface ToolchainOptions { gitEnabled: boolean; gitAccess: GitAccess; hostGit: boolean; refresh: boolean }

/** Python command-line tools through uv (each in its own environment, commands in uv's bin folder on PATH). */
const setupPythonTools = (env: ToolEnv, tools: string[]): void => {
  const uv = tool('uv', 'uv.exe');
  if (!exists(uv)) throw new Error('toolchains.python.tools needs uv (toolchains.uv.enabled)');
  installOnce(env, 'uv tool', tools, (pkg) => exec(uv, ['tool', 'install', pkg], { env: { ...process.env, ...env.vars } }));
};

/** Provisions every enabled toolchain and returns the combined environment for the agent. */
export const setupToolchains = async (config: Toolchains, versions: ToolVersions, options: ToolchainOptions): Promise<ToolEnv> => {
  const env = emptyEnv();
  env.prepend.push(mkdirp(tool('bin')));
  // Order matters only where one tool uses another: C/C++ is Rust's linker, uv installs the Python tools.
  const plan: [boolean, string, () => Promise<void> | void][] = [
    [options.gitEnabled, 'Git', () => setupGit(env, options.hostGit, options.refresh, options.gitAccess)],
    [true, 'nvm + Node ' + versions.node.spec, () => setupNode(env, versions, config.node)],
    [wanted(config.python.enabled, 'python'), 'Python', () => setupPython(env, config.python, versions)],
    [wanted(config.cpp.enabled, 'cpp') || wanted(config.rust.enabled, 'rust'), 'C/C++ (MinGW-w64)', () => setupCpp(env, config.cpp)],
    [wanted(config.rust.enabled, 'rust'), 'Rust', () => setupRust(env, config.rust, options.refresh)],
    [wanted(config.dotnet.enabled, 'dotnet'), '.NET SDK', () => setupDotnet(env, config.dotnet, options.refresh)],
    [wanted(config.go.enabled, 'go'), 'Go', () => setupGo(env, config.go)],
    [wanted(config.java.enabled, 'java'), 'Java', () => setupJava(env, config.java)],
    [wanted(config.ruby.enabled, 'ruby'), 'Ruby', () => setupRuby(env, config.ruby)],
    [wanted(config.php.enabled, 'php'), 'PHP', () => setupPhp(env, config.php)],
    [wanted(config.deno.enabled, 'deno'), 'Deno', () => setupDeno(env)],
    [config.bun.enabled, 'Bun', () => setupBun(env)],
    [config.uv.enabled, 'uv', () => setupUv(env)],
    [config.vcRuntime.enabled, 'Visual C++ runtime', () => setupVcRuntime(env)],
    [config.mesa.enabled, 'Mesa 3D (software OpenGL)', () => setupMesa(env)],
    [config.vscode.enabled, 'VS Code', () => setupVscode(env, options.refresh)],
    [wanted(config.python.enabled, 'python') && config.python.tools.length > 0, 'Python tools', () => setupPythonTools(env, config.python.tools)],
  ];
  for (const [enabled, name, work] of plan) if (enabled) await step(name, env, async () => work());
  Object.assign(env.vars, config.environment);
  return env;
};

