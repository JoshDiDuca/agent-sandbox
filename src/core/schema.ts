// Every setting, defined once with zod: the user config (~/.agent-sandbox/config.json) and the much smaller subset a
// project's .sandbox-config.json may change. Types are inferred from these schemas, and the JSON Schema files in
// schemas/ (editor autocomplete and docs via "$schema") are generated from them at build time.
import _ from 'lodash';
import { z } from 'zod';

const RESERVED_GUEST = /^C:\\(?:Windows|Program Files|Program Files \(x86\)|ProgramData|Users|AgentLaunch|AgentData|HostTools|nvm)(?:\\|$)/i;

export const GuestPath = z.string().refine(
  (v) => /^C:\\/.test(v) && !v.includes('..') && v !== 'C:\\' && !RESERVED_GUEST.test(v),
  'reserved or invalid guest path (must be a folder under C:\\, not Windows, Program Files, Users, AgentData, ...)',
);
const Name = z.string().regex(/^[A-Za-z0-9_-]+$/, 'letters, numbers, - and _ only');
const Strings = z.array(z.string());
const toggle = (description: string) => z.strictObject({ enabled: z.boolean().describe(description) });
const SchemaRef = z.string().describe('Path or URL of the JSON Schema for editor autocomplete and docs.');

export const GitAccess = z.enum(['full', 'readonly', 'none'])
  .describe('full: normal git. readonly: status/log/diff/show/blame only (no commit, push, checkout, ...). none: no git at all; .git is hidden from the agent.');
const GuestWorkspace = z.union([z.literal('auto'), GuestPath]).describe('Where the workspace appears inside the sandbox. "auto" = C:\\Workspace\\<folder name>.');

export const Mapping = z.strictObject({
  host: z.string().min(1).describe('Folder on this PC (relative paths are relative to the config file).'),
  guest: GuestPath.describe('Where it appears inside the sandbox, e.g. C:\\Assets.'),
  readOnly: z.boolean().describe('true = the agent can only read it.'),
  optional: z.boolean().optional().describe('true = skip it quietly when the host folder does not exist.'),
});

export const Harness = z.strictObject({
  hostExecutable: z.string().optional().describe('Executable copied from this PC when installed here (e.g. claude.exe).'),
  hostDir: z.string().optional().describe('Folder of hostExecutable on this PC, or "auto" to search PATH and ~/.local/bin.'),
  npmPackage: z.string().optional().describe('npm package installed inside the sandbox when there is no host copy.'),
  npmBin: z.string().optional().describe('Command the npm package provides.'),
  uvPackage: z.string().optional().describe('Python package installed with `uv tool install` inside the sandbox (e.g. aider-chat).'),
  uvBin: z.string().optional().describe('Command the uv package provides.'),
  arguments: Strings.describe('Arguments always passed to the agent.'),
  environment: z.record(z.string(), z.string()).describe('Environment variables for the agent.'),
  resumeArguments: Strings.optional().describe('Arguments used when the agent is restarted in place (e.g. after an account switch) so it resumes the conversation.'),
})
  .refine((h) => h.hostExecutable || h.npmPackage || h.uvPackage, 'needs hostExecutable, npmPackage or uvPackage')
  .refine((h) => !h.uvPackage || h.uvBin, 'needs uvBin when uvPackage is set')
  .refine((h) => !h.npmPackage || h.npmBin, 'needs npmBin when npmPackage is set');

const Sandbox = z.strictObject({
  memoryMb: z.union([z.literal('auto'), z.number().int().min(2048)]).describe('Sandbox RAM in MB (>= 2048), or "auto": free RAM minus reserveHostMb, capped at maxMemoryMb.'),
  maxMemoryMb: z.number().int().positive().describe('Upper limit for memoryMb "auto".'),
  reserveHostMb: z.number().int().nonnegative().describe('RAM always left for this PC when memoryMb is "auto".'),
  vGpu: z.boolean().describe('Virtual GPU. Off by default: Microsoft notes it widens the sandbox attack surface.'),
  networking: z.boolean().describe('Internet access. false is the only hard network isolation Windows Sandbox offers.'),
  clipboard: z.boolean().describe('Shared clipboard between this PC and the sandbox.'),
  audioInput: z.boolean().describe('Microphone access.'),
  videoInput: z.boolean().describe('Camera access.'),
  printerRedirection: z.boolean().describe('Printers from this PC.'),
  protectedClient: z.boolean().describe('Run the sandbox window in Protected Client mode (recommended).'),
  headless: z.boolean().describe('Hide the sandbox window (sbx-show brings it back). A headless sandbox shuts down when its last session ends.'),
});
const Git = z.strictObject({ enabled: z.boolean().describe('Provide Git for Windows (and Git Bash, which Claude Code needs).'), access: GitAccess });
const Provisioning = z.strictObject({
  copyFromHost: z.boolean().describe('Copy Node, Git, nvm and the agent from this PC when they are installed here.'),
  fallbackToInstall: z.boolean().describe('Download anything that cannot be copied from this PC.'),
  refresh: z.boolean().describe('Re-copy / re-download everything on the next launch.'),
  git: Git,
  terminal: toggle('Windows Terminal as the sandbox window (downloaded once).'),
});
/** true, false, or "auto": only when the project uses it (found from files like go.mod in the workspace or one level down). */
export const Enabled = z.union([z.boolean(), z.literal('auto')]);
const enabled = (what: string, markers: string) => Enabled.describe(what + ' true, false, or "auto" = only when the project has ' + markers + '.');
const Packages = (what: string, example: string) => Strings.describe(what + ', installed once and kept (e.g. ' + example + ').');

const Toolchains = z.strictObject({
  node: z.strictObject({
    version: z.string().min(1).describe('Default Node version for nvm. "host" = the Node on this PC. A project\'s .nvmrc / .node-version wins.'),
    extraVersions: Strings.describe('More Node versions to install (switch with nvm use). On top of the up to 3 versions copied from this PC\'s nvm, not counted towards that limit.'),
    corepack: z.boolean().describe('pnpm and yarn through corepack (a project\'s "packageManager" in package.json picks the version).'),
    globalPackages: Packages('npm packages installed globally into the default Node version', '["typescript", "npm-check-updates"]'),
  }),
  python: z.strictObject({
    enabled: enabled('Python 3 (CPython with pip).', 'pyproject.toml, requirements.txt, setup.py, Pipfile or .python-version'),
    version: z.string().min(1).describe('Python 3 version prefix, e.g. "3" or "3.12". A project\'s .python-version wins.'),
    python2: z.boolean().describe('Also install Python 2.7 as python2 / pip2.'),
    tools: Packages('Python command-line tools installed with `uv tool install` (needs uv)', '["poetry", "ruff", "pre-commit"]'),
  }),
  rust: z.strictObject({
    enabled: enabled('Rust via rustup (cargo, rustc).', 'Cargo.toml or rust-toolchain(.toml)'),
    toolchain: z.string().min(1).describe('Default toolchain, e.g. "stable". rust-toolchain.toml in a project wins.'),
    host: z.string().min(1).describe('Host triple. The GNU host needs no Visual Studio; MinGW (cpp) is its linker.'),
    components: Packages('Extra rustup components', '["rust-src", "llvm-tools"]'),
    targets: Packages('Extra rustup targets', '["wasm32-unknown-unknown"]'),
    crates: Packages('Binaries built with `cargo install` (compiled once, slow the first time)', '["cargo-watch"]'),
  }),
  cpp: z.strictObject({
    enabled: enabled('MinGW-w64 GCC with CMake, Ninja, premake5 and mingw32-make (also Rust\'s linker).', 'CMakeLists.txt, Makefile, meson.build, premake5.lua or Cargo.toml'),
    flexBison: z.boolean().describe('win_flex / win_bison, the parser generators many C/C++ projects (game engines among them) need; CMake finds them.'),
  }),
  dotnet: z.strictObject({
    enabled: enabled('.NET SDK (C#, F#).', 'a .sln, .slnx, .csproj, .fsproj or global.json'),
    channels: Strings.describe('SDK channels, e.g. ["LTS", "8.0"]. A project\'s global.json is installed too.'),
    tools: Packages('Global .NET tools (`dotnet tool install -g`)', '["dotnet-ef", "csharpier"]'),
    workloads: Packages('SDK workloads (`dotnet workload install`)', '["aspire", "wasm-tools"]'),
    frameworkTargets: Strings.describe('.NET Framework reference assemblies (targeting packs) from NuGet, so net4x and old-style .csproj projects build without Visual Studio, e.g. ["net48", "net472", "net462"]. The 4.8 runtime itself ships with Windows.'),
    netfx35: z.boolean().describe('.NET Framework 3.5 runtime (a Windows feature, enabled from Windows Update on every boot; a few minutes).'),
  }),
  go: z.strictObject({
    enabled: enabled('Go.', 'go.mod or go.work'),
    version: z.string().min(1).describe('"stable" or a version prefix such as "1.23". A go.mod asking for newer fetches it itself (GOTOOLCHAIN=auto).'),
    tools: Packages('Go tools (`go install <path>@<version>`)', '["golang.org/x/tools/gopls@latest"]'),
  }),
  java: z.strictObject({
    enabled: enabled('Java: Eclipse Temurin JDK.', 'pom.xml, build.gradle(.kts), settings.gradle(.kts), mvnw, gradlew or .java-version'),
    version: z.string().min(1).describe('"lts" (newest LTS) or a major version such as "21". A project\'s .java-version or .sdkmanrc wins.'),
    maven: z.boolean().describe('Apache Maven (mvn). A project\'s mvnw works either way.'),
    gradle: z.boolean().describe('Gradle (gradle). A project\'s gradlew works either way.'),
  }),
  ruby: z.strictObject({
    enabled: enabled('Ruby (RubyInstaller, with gem and bundler). Gems with C extensions need MSYS2, which is not included.', 'Gemfile, a .gemspec or .ruby-version'),
    version: z.string().min(1).describe('Version prefix, e.g. "3" or "3.3". A project\'s .ruby-version wins.'),
    gems: Packages('Gems installed globally', '["rubocop"]'),
  }),
  php: z.strictObject({
    enabled: enabled('PHP (with the Visual C++ runtime it needs, installed on every boot).', 'composer.json, artisan or .php-version'),
    version: z.string().min(1).describe('Version prefix, e.g. "8" or "8.3". A project\'s .php-version wins.'),
    composer: z.boolean().describe('Composer.'),
  }),
  deno: z.strictObject({ enabled: enabled('Deno.', 'deno.json, deno.jsonc or deno.lock') }),
  bun: toggle('Bun runtime (claude-mem needs it).'),
  uv: toggle('uv, the Python package manager (claude-mem needs it).'),
  vcRuntime: toggle('Microsoft Visual C++ runtime for tools that need it (a real installer, so it runs on every boot, ~15 s). PHP installs it regardless.'),
  mesa: toggle('Mesa 3D (llvmpipe): OpenGL 4.5 in software for games and apps when there is no GPU (sandbox.vGpu off). Copy opengl32.dll and libgallium_wgl.dll from %MESA_DIR% next to the program\'s .exe.'),
  vscode: toggle('Portable VS Code inside the sandbox (code on PATH, desktop shortcut); its settings and extensions persist.'),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'letters, digits and _ only'), z.string()).describe('Extra environment variables for the agent and every terminal, e.g. registry mirrors: {"NPM_CONFIG_REGISTRY": "https://...", "PIP_INDEX_URL": "https://..."}.'),
});
const Port = z.number().int().min(1024).max(65535);
const dbEnabled = (name: string) => Enabled.describe(name + ': true, false, or "auto" = only when the project needs it (found from compose files, dependencies of every language, Prisma/ORM config and connection strings).');
const Databases = z.strictObject({
  postgres: z.strictObject({
    enabled: dbEnabled('PostgreSQL (with psql, pg_dump). User postgres, no password, localhost only'),
    version: z.string().min(1).describe('"latest" or a major version such as "16". A compose file pinning postgres:<major> wins.'),
    port: Port.describe('Port inside the sandbox.'),
  }),
  mysql: z.strictObject({
    enabled: dbEnabled('MySQL-compatible database (MariaDB). User root, no password, localhost only'),
    version: z.string().min(1).describe('"lts" (newest MariaDB LTS) or a MariaDB series such as "11.4".'),
    port: Port.describe('Port inside the sandbox.'),
  }),
  mongodb: z.strictObject({
    enabled: dbEnabled('MongoDB with mongosh, localhost only'),
    version: z.string().min(1).describe('"latest" or a version prefix such as "8.0".'),
    port: Port.describe('Port inside the sandbox.'),
  }),
  redis: z.strictObject({
    enabled: dbEnabled('Redis (community Windows build), localhost only'),
    port: Port.describe('Port inside the sandbox.'),
  }),
  dynamodb: z.strictObject({
    enabled: dbEnabled('DynamoDB Local (Amazon\'s official emulator, on the Java toolchain) with dynamodb-admin, a web UI to browse and edit tables'),
    port: Port.describe('DynamoDB endpoint port inside the sandbox (http://localhost:<port>).'),
    adminPort: Port.describe('dynamodb-admin web UI port (open http://localhost:<adminPort> in the sandbox\'s browser).'),
    admin: z.boolean().describe('Run dynamodb-admin next to DynamoDB Local.'),
  }),
  sqlserver: z.strictObject({
    enabled: dbEnabled('SQL Server. It cannot run inside Windows Sandbox; when a project needs it you get a hint to reach the one on this PC through hostAccess.forwards'),
  }),
});
const Secrets = z.strictObject({
  strip: z.boolean().describe('Remove credentials from everything copied into the sandbox (your Claude settings.json "env" and credential helpers, MCP servers\' env, headers and arguments): AWS, Azure, Google Cloud, Cloudflare, hosting, CI, registries, payment, AI API keys, database URLs, anything named *_TOKEN / *_SECRET / *PASSWORD* / *_KEY or *PROD*, and values that look like keys.'),
  allow: Strings.describe('Variable names that may go in anyway; * matches anything, e.g. ["AWS_REGION", "AWS_PROFILE", "MY_APP_*"].'),
  patterns: Strings.describe('More variable names to treat as secrets; * matches anything, e.g. ["ACME_*", "*_INTERNAL_URL"].'),
  warnFiles: z.boolean().describe('Warn at launch about files in the workspace that usually hold secrets (.env, *.pem, credentials.json, ...). The agent CAN read them: Windows Sandbox maps the whole folder.'),
});
const Attach = z.strictObject({
  enabled: z.boolean().describe('Allow claude-sbx --terminal / sandbox attach from this PC.'),
  reuseSession: z.boolean().describe('claude-sbx -t in a running sandbox reattaches to this folder\'s session when no terminal on this PC is attached to it (--new always starts another).'),
});
const ClaudeProfile = z.strictObject({
  enabled: z.boolean().describe('Copy selected Claude settings from this PC into the sandbox.'),
  hostDir: z.string().describe('Your Claude folder, or "auto" (~/.claude or CLAUDE_CONFIG_DIR).'),
  include: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)).describe('Files and folders copied from it.'),
  globalStateFile: z.string().describe('Your .claude.json, or "auto". Empty string = do not copy.'),
  copyCredentials: z.boolean().describe('Copy your Claude LOGIN into the sandbox. Prefer sandbox account instead.'),
  overwrite: z.boolean().describe('Refresh these settings from this PC on every launch.'),
  syncHistory: z.boolean().describe('Bring all conversation history in, and sync new history back (path-translated).'),
  syncClaudeMem: z.boolean().describe('Bring claude-mem data in, and its database back when the sandbox closes.'),
});

export const Config = z.strictObject({
  $schema: SchemaRef.optional(),
  defaultHarness: Name.describe('Agent started by `sandbox launch` (claude-sbx always runs claude).'),
  guestWorkspace: GuestWorkspace,
  readOnly: z.boolean().describe('Map the workspace read-only.'),
  mappings: z.array(Mapping).describe('Extra folders from this PC.'),
  sandbox: Sandbox,
  storage: z.strictObject({
    root: z.string().min(1).describe('Where agent-sandbox keeps everything on this PC (tools, logins, launches).'),
    persistAgentState: z.boolean().describe('Keep agent logins and history between sandboxes.'),
    dataName: Name.describe('Name of the persistent data set (C:\\AgentData) shared by all workspaces.'),
  }),
  network: z.strictObject({ blockPrivateRanges: z.boolean().describe('Block your LAN (10/8, 172.16/12, 192.168/16, SMB) from inside the sandbox.') }),
  provisioning: Provisioning,
  toolchains: Toolchains,
  databases: Databases.describe('Databases running inside the sandbox. Data persists in C:\\AgentData\\databases; each one starts at boot.'),
  attach: Attach,
  secrets: Secrets,
  personalization: toggle('Copy your desktop look (theme, accent, taskbar, wallpaper, ...) into the sandbox.'),
  claudeProfile: ClaudeProfile,
  harnesses: z.record(Name, Harness).describe('Agents that can run in the sandbox.'),
  hooks: z.strictObject({ failFast: z.boolean().describe('Stop when a hook script fails.') }),
}).refine((c) => c.harnesses[c.defaultHarness] !== undefined, { message: 'defaultHarness must be one of the configured harnesses', path: ['defaultHarness'] });

/**
 * What a project's .sandbox-config.json may change. A repo can ship this file, so it can NOT touch storage, agent
 * executables, host folders for tools or Claude settings, or anything else outside this list.
 */
export const LocalOverrides = z.strictObject({
  $schema: SchemaRef,
  harness: Name.describe('Agent for this project.'),
  guestWorkspace: GuestWorkspace,
  readOnly: z.boolean().describe('Map this project read-only.'),
  mappings: z.array(Mapping).describe('Extra folders (relative to this file).'),
  scripts: Strings.describe('Scripts (.ps1 / .mjs / .cmd, relative to this file) run inside the sandbox before the agent.'),
  sandbox: Sandbox.partial(),
  network: z.strictObject({ blockPrivateRanges: z.boolean() }).partial(),
  provisioning: Provisioning.pick({ copyFromHost: true, fallbackToInstall: true, refresh: true }).extend({ git: Git.partial(), terminal: toggle('Windows Terminal as the sandbox window.').partial() }).partial(),
  // Every toolchain setting, each one optional (a project usually only switches languages on or pins a version).
  toolchains: z.strictObject({
    ..._.mapValues(_.omit(Toolchains.shape, 'environment'), (shape) => shape.partial()),
    environment: Toolchains.shape.environment,
  }).partial(),
  databases: z.strictObject(_.mapValues(Databases.shape, (shape) => shape.partial())).partial(),
  attach: Attach.partial(),
  personalization: toggle('Copy your desktop look into the sandbox.').partial(),
  claudeProfile: ClaudeProfile.pick({ enabled: true, include: true, overwrite: true, copyCredentials: true, syncHistory: true, syncClaudeMem: true }).partial(),
  hooks: z.strictObject({ failFast: z.boolean() }).partial(),
}).partial();

/** One readable line per problem: "sandbox.memoryMb: Too small: expected number to be >=2048". */
export const describeIssues = (error: z.ZodError): string[] => error.issues.map((issue) => {
  const at = issue.path.join('.');
  if (issue.code === 'unrecognized_keys') return issue.keys.map((k) => (at ? at + '.' : '') + k + ' is not allowed here').join('; ');
  return (at || 'value') + ': ' + issue.message;
});

/** JSON Schema documents for editors. The user config only lists what it changes, so nothing in it is required. */
export const jsonSchemas = (): Record<string, object> => {
  const dropRequired = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(dropRequired);
    if (typeof node !== 'object' || node === null) return node;
    return Object.fromEntries(Object.entries(node).filter(([k]) => k !== 'required').map(([k, v]) => [k, dropRequired(v)]));
  };
  const toSchema = (schema: z.ZodType, title: string): object => ({ title, ...(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as object) });
  return {
    'config.schema.json': dropRequired(toSchema(Config, 'agent-sandbox user config (~/.agent-sandbox/config.json)')) as object,
    'sandbox-config.schema.json': toSchema(LocalOverrides, 'agent-sandbox project config (.sandbox-config.json)'),
  };
};

export type ConfigT = z.output<typeof Config>;
export type OverridesT = z.output<typeof LocalOverrides>;
