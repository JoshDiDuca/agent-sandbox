// Every setting, defined once with zod: the user config (~/.agent-sandbox/config.json) and the much smaller subset a
// project's .sandbox-config.json may change. Types are inferred from these schemas, and the JSON Schema files in
// schemas/ (editor autocomplete and docs via "$schema") are generated from them at build time.
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
  arguments: Strings.describe('Arguments always passed to the agent.'),
  environment: z.record(z.string(), z.string()).describe('Environment variables for the agent.'),
  resumeArguments: Strings.optional().describe('Arguments used when the agent is restarted in place (e.g. after an account switch) so it resumes the conversation.'),
})
  .refine((h) => h.hostExecutable || h.npmPackage, 'needs hostExecutable or npmPackage')
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
const Toolchains = z.strictObject({
  node: z.strictObject({
    version: z.string().min(1).describe('Default Node version for nvm. "host" = the Node on this PC. A project\'s .nvmrc / .node-version wins.'),
    extraVersions: Strings.describe('More Node versions to install (switch with nvm use). On top of the up to 3 versions copied from this PC\'s nvm, not counted towards that limit.'),
  }),
  python: z.strictObject({
    enabled: z.boolean().describe('Python 3 (CPython with pip).'),
    version: z.string().min(1).describe('Python 3 version prefix, e.g. "3" or "3.12". A project\'s .python-version wins.'),
    python2: z.boolean().describe('Also install Python 2.7 as python2 / pip2.'),
  }),
  rust: z.strictObject({
    enabled: z.boolean().describe('Rust via rustup (cargo, rustc).'),
    toolchain: z.string().min(1).describe('Default toolchain, e.g. "stable". rust-toolchain.toml in a project wins.'),
    host: z.string().min(1).describe('Host triple. The GNU host needs no Visual Studio; MinGW (cpp) is its linker.'),
  }),
  cpp: toggle('MinGW-w64 GCC: gcc, g++, mingw32-make.'),
  dotnet: z.strictObject({ enabled: z.boolean().describe('.NET SDK (C#).'), channels: Strings.describe('SDK channels, e.g. ["LTS", "8.0"]. A project\'s global.json is installed too.') }),
  bun: toggle('Bun runtime.'),
  uv: toggle('uv (Python package manager).'),
  vscode: toggle('Portable VS Code inside the sandbox (code on PATH, desktop shortcut); its settings and extensions persist.'),
});
const Attach = z.strictObject({
  enabled: z.boolean().describe('Allow claude-sbx --terminal / agent-sandbox attach from this PC.'),
  reuseSession: z.boolean().describe('claude-sbx -t in a running sandbox reattaches to this folder\'s session when no terminal on this PC is attached to it (--new always starts another).'),
});
const ClaudeProfile = z.strictObject({
  enabled: z.boolean().describe('Copy selected Claude settings from this PC into the sandbox.'),
  hostDir: z.string().describe('Your Claude folder, or "auto" (~/.claude or CLAUDE_CONFIG_DIR).'),
  include: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)).describe('Files and folders copied from it.'),
  globalStateFile: z.string().describe('Your .claude.json, or "auto". Empty string = do not copy.'),
  copyCredentials: z.boolean().describe('Copy your Claude LOGIN into the sandbox. Prefer agent-sandbox account instead.'),
  overwrite: z.boolean().describe('Refresh these settings from this PC on every launch.'),
  syncHistory: z.boolean().describe('Bring all conversation history in, and sync new history back (path-translated).'),
  syncClaudeMem: z.boolean().describe('Bring claude-mem data in, and its database back when the sandbox closes.'),
});

export const Config = z.strictObject({
  $schema: SchemaRef.optional(),
  defaultHarness: Name.describe('Agent started by `agent-sandbox launch` (claude-sbx always runs claude).'),
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
  attach: Attach,
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
  toolchains: z.strictObject({
    node: Toolchains.shape.node.partial(), python: Toolchains.shape.python.partial(), rust: Toolchains.shape.rust.partial(),
    cpp: Toolchains.shape.cpp.partial(), dotnet: Toolchains.shape.dotnet.partial(), bun: Toolchains.shape.bun.partial(), uv: Toolchains.shape.uv.partial(), vscode: Toolchains.shape.vscode.partial(),
  }).partial(),
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
