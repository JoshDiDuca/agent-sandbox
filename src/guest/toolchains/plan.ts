// Which toolchain and database steps this sandbox runs, in the order their PATH entries are listed, and what each
// step depends on. The scheduler (index.ts) runs them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, DatabasePlan, GitAccess, Toolchains, ToolVersions } from '../../core/types.js';
import { appsNeedMesa, setupApps } from '../apps/index.js';
import { dataDir, dryRun, execAsync, exists, localDir, mkdirp } from '../env.js';
import { ensureCompiled } from '../helpers.js';
import { arch, installOnce, tool, wanted, type ToolEnv } from './common.js';
import { DATABASE_NAMES, setupDatabase } from './databases/index.js';
import { setupGit } from './git.js';
import { setupGo } from './go.js';
import { setupJava } from './java.js';
import { setupCli } from './cli.js';
import { setupPyenv, setupVolta, wantsPyenv, wantsVolta } from './managers.js';
import { setupCpp } from './native/cpp.js';
import { setupDotnet } from './native/dotnet.js';
import { setupMesa } from './native/mesa.js';
import { setupMsvc } from './native/msvc/index.js';
import { setupRust } from './native/rust.js';
import { setupNode } from './node.js';
import { setupPwsh } from './pwsh.js';
import { setupPython } from './python.js';
import { setupBun, setupDeno, setupUv, uvVars } from './runtimes.js';
import { setupPhp } from './scripting/php.js';
import { setupRuby } from './scripting/ruby.js';
import { setupVcRuntime } from './scripting/vcruntime.js';
import { setupVscode } from './vscode.js';

/** apps: the boot only (apps are machine-wide; a project that joins later shares them). */
export interface ToolchainOptions { gitEnabled: boolean; gitAccess: GitAccess; hostGit: boolean; refresh: boolean; databases: DatabasePlan[]; apps?: Config['apps'] }

/**
 * shared: the step's effect is machine-wide and the same for every project (an installer, a registry entry, a
 * shortcut, the git guard). A project added after boot reuses what the boot's run contributed instead of running it
 * again under the sessions that already use it.
 */
export interface Step { name: string; on: boolean; after?: string[]; shared?: boolean; run: (env: ToolEnv) => Promise<void> | void }

/** Python command-line tools through uv (each in its own environment, commands in uv's bin folder on PATH). */
const setupPythonTools = async (env: ToolEnv, tools: string[]): Promise<void> => {
  const uv = tool('uv', 'uv.exe');
  if (!exists(uv)) throw new Error('toolchains.python.tools needs uv (toolchains.uv.enabled)');
  await installOnce(env, 'uv tool', tools, (pkg) => execAsync(uv, ['tool', 'install', pkg], { env: { ...process.env, ...uvVars() } }));
};

/**
 * Where cargo builds: shared with the PC's target\, one on the sandbox's disk, or a path. "separate" sets no variable:
 * the cargo shim (sandbox/cargoshim.cs) gives every checkout its own target\sandbox, so git worktrees of several agents
 * never overwrite each other's builds.
 */
const cargoTarget = (targetDir: Toolchains['rust']['targetDir']): string | null => {
  if (targetDir === 'shared' || targetDir === 'separate') return null;
  if (targetDir === 'local') return path.join(localDir, 'cargo-target');
  return targetDir;
};

/** "separate": tools\shims\cargo\cargo.exe in front of the real cargo, which it runs with the checkout's target dir. */
const cargoShim = (env: ToolEnv, rust: Toolchains['rust']): void => {
  const real = path.join(tool('rust', 'cargo', 'bin'), 'cargo.exe');
  if (rust.targetDir !== 'separate' || !exists(real)) return;
  const dir = mkdirp(tool('shims', 'cargo'));
  fs.copyFileSync(ensureCompiled('cargoshim'), path.join(dir, 'cargo.exe'));
  env.prepend.unshift(dir);
  env.vars.AGENT_REAL_CARGO = real;
};

/**
 * Cargo defaults that fit Windows, written only when there is no $CARGO_HOME\config.toml yet: fewer parallel jobs
 * (parallel rustc ran out of paging file) and, for the GNU host, only line tables as debug info (full debug info made
 * test executables bigger than the 2 GB Windows allows).
 */
const cargoDefaults = (host: string): void => {
  const file = tool('rust', 'cargo', 'config.toml');
  if (exists(file) || !exists(path.dirname(file))) return;
  // Several agents often build at once: up to 4 jobs each (8 each crashed Windows inside the sandbox on 13 Oct 2026).
  const jobs = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 4)));
  const gnu = host.endsWith('-gnu');
  fs.writeFileSync(file, [
    '# Written by windows-development-sandbox once; edit freely, it is never overwritten.',
    '[build]', 'jobs = ' + jobs, '',
    ...(gnu ? ['[profile.dev]', 'debug = "line-tables-only"', '', '[profile.test]', 'debug = "line-tables-only"', ''] : []),
  ].join('\n'));
};

/**
 * Where cargo builds and where sccache keeps its cache. Cargo fingerprints hold absolute paths and the host toolchain,
 * so a target\\ shared with builds on the PC rebuilds every time the side changes: "separate" (the default) keeps a
 * sandbox one next to it. sccache's cache persists unless the project sets SCCACHE_DIR itself.
 */
const rustCaches = (rust: Toolchains['rust']): Record<string, string> => {
  const target = cargoTarget(rust.targetDir);
  return { ...(target ? { CARGO_TARGET_DIR: target } : {}), ...(process.env.SCCACHE_DIR ? {} : { SCCACHE_DIR: path.join(dataDir, 'cache', 'sccache') }) };
};

/** "auto": the msvc host when the MSVC step runs (as on most PCs), else GNU with MinGW. */
const rustHost =(config: Toolchains): string => {
  if (config.rust.host !== 'auto') return config.rust.host;
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64';
  return cpu + (wanted(config.msvc.enabled, 'msvc') ? '-pc-windows-msvc' : '-pc-windows-gnu');
};

export const plan = (config: Toolchains, versions: ToolVersions, o: ToolchainOptions): Step[] => {
  const apps = Boolean(o.apps && (o.apps.install.length || Object.keys(o.apps.custom).length));
  const java = wanted(config.java.enabled, 'java');
  const python = wanted(config.python.enabled, 'python');
  return [
    { name: 'Git', on: o.gitEnabled, shared: true, run: (env) => setupGit(env, o.hostGit, o.refresh, o.gitAccess) },
    // Before Node: with package.json pins, Volta's node/npm/pnpm/yarn come first on PATH.
    { name: 'Volta', on: wantsVolta(config.node.volta), run: (env) => setupVolta(env) },
    { name: 'Node ' + versions.node.spec, on: true, run: (env) => setupNode(env, versions, config.node) },
    { name: 'Python', on: python, run: (env) => setupPython(env, config.python, versions) },
    { name: 'pyenv-win', on: python && wantsPyenv(config.python.pyenv), run: (env) => setupPyenv(env) },
    { name: 'C/C++', on: wanted(config.cpp.enabled, 'cpp') || wanted(config.rust.enabled, 'rust'), run: (env) => setupCpp(env, config.cpp) },
    { name: 'MSVC', on: wanted(config.msvc.enabled, 'msvc'), run: (env) => setupMsvc(env, config.msvc) },
    // Rust links with MSVC (msvc host) or MinGW's gcc (GNU host): whichever it uses goes first.
    {
      name: 'Rust', on: wanted(config.rust.enabled, 'rust'), after: ['C/C++', 'MSVC'],
      run: async (env) => {
        await setupRust(env, { ...config.rust, host: rustHost(config) }, o.refresh);
        Object.assign(env.vars, rustCaches(config.rust));
        if (!dryRun) { cargoDefaults(rustHost(config)); cargoShim(env, config.rust); }
      },
    },
    { name: '.NET', on: wanted(config.dotnet.enabled, 'dotnet'), run: (env) => setupDotnet(env, config.dotnet, o.refresh) },
    { name: 'Go', on: wanted(config.go.enabled, 'go'), run: (env) => setupGo(env, config.go) },
    { name: 'Java', on: java, run: (env) => setupJava(env, config.java) },
    { name: 'Ruby', on: wanted(config.ruby.enabled, 'ruby'), run: (env) => setupRuby(env, config.ruby) },
    // PHP installs the Visual C++ runtime itself: one installer at a time.
    // Many apps (bat, delta, Neovim, most GUIs, your own programs) are built against it too.
    { name: 'Visual C++ runtime', on: config.vcRuntime.enabled || apps, shared: true, run: async (env) => { await setupVcRuntime(env); } },
    { name: 'PHP', on: wanted(config.php.enabled, 'php'), after: ['Visual C++ runtime'], run: (env) => setupPhp(env, config.php) },
    { name: 'Deno', on: wanted(config.deno.enabled, 'deno'), run: (env) => setupDeno(env) },
    { name: 'Bun', on: config.bun.enabled, run: (env) => setupBun(env) },
    { name: 'uv', on: config.uv.enabled, run: (env) => setupUv(env) },
    { name: 'PowerShell 7', on: wanted(config.pwsh.enabled, 'pwsh'), run: (env) => setupPwsh(env, o.refresh) },
    // The openssl tool comes from Git's install: after Git.
    { name: 'CLI tools', on: Object.values(config.cli).some((v) => v !== false), after: ['Git'], run: (env) => setupCli(env, config.cli, o.gitAccess, o.refresh) },
    { name: 'Mesa 3D', on: config.mesa.enabled || appsNeedMesa(o.apps), shared: true, run: (env) => setupMesa(env, config.mesa) },
    { name: 'VS Code', on: config.vscode.enabled, shared: true, run: (env) => setupVscode(env, o.refresh) },
    // Desktop apps and extra tools (apps.install / apps.custom); games and 3D apps copy Mesa's OpenGL next to them.
    { name: 'Apps', on: apps, shared: true, after: ['Mesa 3D', 'Visual C++ runtime'], run: (env) => setupApps(env, o.apps!, { gitAccess: o.gitAccess, refresh: o.refresh }) },
    { name: 'Python tools', on: python && config.python.tools.length > 0, after: ['Python', 'uv'], run: (env) => setupPythonTools(env, config.python.tools) },
    // DynamoDB Local runs on Java: the Java step installs the JDK first instead of racing it.
    // One server per database in the sandbox: a project that joins later shares the one the boot started.
    ...o.databases.map((db): Step => ({ name: DATABASE_NAMES[db.database], on: true, shared: true, after: db.database === 'dynamodb' && java ? ['Java'] : [], run: (env) => setupDatabase(env, db) })),
  ];
};
