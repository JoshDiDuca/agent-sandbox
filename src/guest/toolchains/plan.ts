// Which toolchain and database steps this sandbox runs, in the order their PATH entries are listed, and what each
// step depends on. The scheduler (index.ts) runs them.
import type { Toolchains, ToolVersions } from '../../core/types.js';
import { appsNeedMesa } from '../apps/index.js';
import { setupApps } from '../apps/installer.js';
import { dryRun } from '../runtime/paths.js';
import { wanted } from './detect.js';
import { DATABASE_NAMES, setupDatabase } from '../databases/index.js';
import { setupGit } from './tools/git.js';
import { setupGo } from './languages/go.js';
import { setupJava } from './languages/java.js';
import { setupCli } from './tools/cli.js';
import { setupPyenv, setupVolta, wantsPyenv, wantsVolta } from './managers.js';
import { setupCpp } from './native/cpp.js';
import { setupDotnet } from './native/dotnet.js';
import { setupMesa } from './native/mesa.js';
import { setupMsvc } from './native/msvc/index.js';
import { setupRust } from './native/rust.js';
import { setupNode } from './languages/node.js';
import { setupPwsh } from './tools/pwsh.js';
import { setupPython } from './languages/python.js';
import { setupBun, setupDeno, setupUv } from './runtimes.js';
import { setupPhp } from './languages/php.js';
import { setupRuby } from './languages/ruby.js';
import { setupVcRuntime } from './native/vcruntime.js';
import { setupVscode } from './tools/vscode.js';
import type { ToolchainOptions, Step } from './step.js';
import { rustHost, rustCaches, cargoDefaults, cargoShim } from './native/rust-extras.js';
import { setupPythonTools } from './languages/python-tools.js';

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
    {
      name: 'C/C++',
      on: wanted(config.cpp.enabled, 'cpp') || wanted(config.rust.enabled, 'rust'),
      run: (env) => setupCpp(env, config.cpp),
    },
    { name: 'MSVC', on: wanted(config.msvc.enabled, 'msvc'), run: (env) => setupMsvc(env, config.msvc) },
    // Rust links with MSVC (msvc host) or MinGW's gcc (GNU host): whichever it uses goes first.
    {
      name: 'Rust',
      on: wanted(config.rust.enabled, 'rust'),
      after: ['C/C++', 'MSVC'],
      run: async (env) => {
        await setupRust(env, { ...config.rust, host: rustHost(config) }, o.refresh);
        Object.assign(env.vars, rustCaches(config.rust));
        if (!dryRun) {
          cargoDefaults(rustHost(config));
          cargoShim(env, config.rust);
        }
      },
    },
    {
      name: '.NET',
      on: wanted(config.dotnet.enabled, 'dotnet'),
      run: (env) => setupDotnet(env, config.dotnet, o.refresh),
    },
    { name: 'Go', on: wanted(config.go.enabled, 'go'), run: (env) => setupGo(env, config.go) },
    { name: 'Java', on: java, run: (env) => setupJava(env, config.java) },
    { name: 'Ruby', on: wanted(config.ruby.enabled, 'ruby'), run: (env) => setupRuby(env, config.ruby) },
    // PHP installs the Visual C++ runtime itself: one installer at a time.
    // Many apps (bat, delta, Neovim, most GUIs, your own programs) are built against it too.
    {
      name: 'Visual C++ runtime',
      on: config.vcRuntime.enabled || apps,
      shared: true,
      run: async (env) => {
        await setupVcRuntime(env);
      },
    },
    {
      name: 'PHP',
      on: wanted(config.php.enabled, 'php'),
      after: ['Visual C++ runtime'],
      run: (env) => setupPhp(env, config.php),
    },
    { name: 'Deno', on: wanted(config.deno.enabled, 'deno'), run: (env) => setupDeno(env) },
    { name: 'Bun', on: config.bun.enabled, run: (env) => setupBun(env) },
    { name: 'uv', on: config.uv.enabled, run: (env) => setupUv(env) },
    { name: 'PowerShell 7', on: wanted(config.pwsh.enabled, 'pwsh'), run: (env) => setupPwsh(env, o.refresh) },
    // The openssl tool comes from Git's install: after Git.
    {
      name: 'CLI tools',
      on: Object.values(config.cli).some((v) => v !== false),
      after: ['Git'],
      run: (env) => setupCli(env, config.cli, o.gitAccess, o.refresh),
    },
    {
      name: 'Mesa 3D',
      on: config.mesa.enabled || appsNeedMesa(o.apps),
      shared: true,
      run: (env) => setupMesa(env, config.mesa),
    },
    { name: 'VS Code', on: config.vscode.enabled, shared: true, run: (env) => setupVscode(env, o.refresh) },
    // Desktop apps and extra tools (apps.install / apps.custom); games and 3D apps copy Mesa's OpenGL next to them.
    {
      name: 'Apps',
      on: apps,
      shared: true,
      after: ['Mesa 3D', 'Visual C++ runtime'],
      run: (env) => setupApps(env, o.apps!, { gitAccess: o.gitAccess, refresh: o.refresh }),
    },
    {
      name: 'Python tools',
      on: python && config.python.tools.length > 0,
      after: ['Python', 'uv'],
      run: (env) => setupPythonTools(env, config.python.tools),
    },
    // DynamoDB Local runs on Java: the Java step installs the JDK first instead of racing it.
    // One server per database in the sandbox: a project that joins later shares the one the boot started.
    ...o.databases.map((db): Step => ({
      name: DATABASE_NAMES[db.database],
      on: true,
      shared: true,
      after: db.database === 'dynamodb' && java ? ['Java'] : [],
      run: (env) => setupDatabase(env, db),
    })),
  ];
};
