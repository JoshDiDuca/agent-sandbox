// Every developer toolchain and database the sandbox provides. Installers run in parallel (a few at a time; downloads
// and installers do not block each other) and each is independent: one failing never blocks the rest. A step that
// needs another (Rust links with MinGW's gcc, uv installs the Python tools) waits for it.
import type { DatabasePlan, GitAccess, Toolchains, ToolVersions } from '../../core/types.js';
import { execAsync, exists, log, mkdirp, setSandboxStatus } from '../env.js';
import { emptyEnv, installOnce, step, tool, wanted, type ToolEnv } from './common.js';
import { DATABASE_NAMES, setupDatabase } from './databases.js';
import { setupGit } from './git.js';
import { setupGo } from './go.js';
import { setupJava } from './java.js';
import { setupPyenv, setupVolta, wantsPyenv, wantsVolta } from './managers.js';
import { setupNode } from './node.js';
import { setupPython } from './python.js';
import { setupCpp, setupDotnet, setupMesa, setupRust } from './native.js';
import { setupBun, setupDeno, setupUv, uvVars } from './runtimes.js';
import { setupPhp, setupRuby, setupVcRuntime } from './scripting.js';
import { setupVscode } from './vscode.js';

export type { ToolEnv } from './common.js';
export { pickNodeVersion, pickPackageVersion } from './versions.js';

export interface ToolchainOptions { gitEnabled: boolean; gitAccess: GitAccess; hostGit: boolean; refresh: boolean; databases: DatabasePlan[] }

/** How many installers run at once: enough to overlap downloads with installs, few enough not to thrash the disk. */
const PARALLEL = 4;

interface Step { name: string; on: boolean; after?: string[]; run: (env: ToolEnv) => Promise<void> | void }

/** Python command-line tools through uv (each in its own environment, commands in uv's bin folder on PATH). */
const setupPythonTools = async (env: ToolEnv, tools: string[]): Promise<void> => {
  const uv = tool('uv', 'uv.exe');
  if (!exists(uv)) throw new Error('toolchains.python.tools needs uv (toolchains.uv.enabled)');
  await installOnce(env, 'uv tool', tools, (pkg) => execAsync(uv, ['tool', 'install', pkg], { env: { ...process.env, ...uvVars() } }));
};

/** The toolchains and databases for this sandbox, in the order their PATH entries are listed. */
const plan = (config: Toolchains, versions: ToolVersions, o: ToolchainOptions): Step[] => {
  const java = wanted(config.java.enabled, 'java');
  return [
    { name: 'Git', on: o.gitEnabled, run: (env) => setupGit(env, o.hostGit, o.refresh, o.gitAccess) },
    // Before Node: with package.json pins, Volta's node/npm/pnpm/yarn come first on PATH.
    { name: 'Volta', on: wantsVolta(config.node.volta), run: (env) => setupVolta(env) },
    { name: 'Node ' + versions.node.spec, on: true, run: (env) => setupNode(env, versions, config.node) },
    { name: 'Python', on: wanted(config.python.enabled, 'python'), run: (env) => setupPython(env, config.python, versions) },
    { name: 'pyenv-win', on: wanted(config.python.enabled, 'python') && wantsPyenv(config.python.pyenv), run: (env) => setupPyenv(env) },
    { name: 'C/C++', on: wanted(config.cpp.enabled, 'cpp') || wanted(config.rust.enabled, 'rust'), run: (env) => setupCpp(env, config.cpp) },
    { name: 'Rust', on: wanted(config.rust.enabled, 'rust'), after: ['C/C++'], run: (env) => setupRust(env, config.rust, o.refresh) },
    { name: '.NET', on: wanted(config.dotnet.enabled, 'dotnet'), run: (env) => setupDotnet(env, config.dotnet, o.refresh) },
    { name: 'Go', on: wanted(config.go.enabled, 'go'), run: (env) => setupGo(env, config.go) },
    { name: 'Java', on: java, run: (env) => setupJava(env, config.java) },
    { name: 'Ruby', on: wanted(config.ruby.enabled, 'ruby'), run: (env) => setupRuby(env, config.ruby) },
    // PHP installs the Visual C++ runtime itself: one installer at a time.
    { name: 'Visual C++ runtime', on: config.vcRuntime.enabled, run: async (env) => { await setupVcRuntime(env); } },
    { name: 'PHP', on: wanted(config.php.enabled, 'php'), after: ['Visual C++ runtime'], run: (env) => setupPhp(env, config.php) },
    { name: 'Deno', on: wanted(config.deno.enabled, 'deno'), run: (env) => setupDeno(env) },
    { name: 'Bun', on: config.bun.enabled, run: (env) => setupBun(env) },
    { name: 'uv', on: config.uv.enabled, run: (env) => setupUv(env) },
    { name: 'Mesa 3D', on: config.mesa.enabled, run: (env) => setupMesa(env) },
    { name: 'VS Code', on: config.vscode.enabled, run: (env) => setupVscode(env, o.refresh) },
    { name: 'Python tools', on: wanted(config.python.enabled, 'python') && config.python.tools.length > 0, after: ['Python', 'uv'], run: (env) => setupPythonTools(env, config.python.tools) },
    // DynamoDB Local runs on Java: the Java step installs the JDK first instead of racing it.
    ...o.databases.map((db): Step => ({ name: DATABASE_NAMES[db.database], on: true, after: db.database === 'dynamodb' && java ? ['Java'] : [], run: (env) => setupDatabase(env, db) })),
  ];
};

/** Provisions every enabled toolchain and database, and returns the combined environment for the agent. */
export const setupToolchains = async (config: Toolchains, versions: ToolVersions, options: ToolchainOptions): Promise<ToolEnv> => {
  const steps = plan(config, versions, options).filter((s) => s.on);
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
