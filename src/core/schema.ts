// Every setting, defined once with zod: the user config (~/.agent-sandbox/config.json) and the much smaller subset a
// project's .sandbox-config.json may change. Types are inferred from these schemas.
import { z } from 'zod';

const RESERVED_GUEST = /^C:\\(?:Windows|Program Files|Program Files \(x86\)|ProgramData|Users|AgentLaunch|AgentData|HostTools|nvm)(?:\\|$)/i;

export const GuestPath = z.string().refine(
  (v) => /^C:\\/.test(v) && !v.includes('..') && v !== 'C:\\' && !RESERVED_GUEST.test(v),
  'reserved or invalid guest path (must be a folder under C:\\, not Windows, Program Files, Users, AgentData, ...)',
);
const Name = z.string().regex(/^[A-Za-z0-9_-]+$/, 'letters, numbers, - and _ only');
const Strings = z.array(z.string());
const Toggle = z.strictObject({ enabled: z.boolean() });

export const GitAccess = z.enum(['full', 'readonly', 'none']);
export const Mapping = z.strictObject({ host: z.string().min(1), guest: GuestPath, readOnly: z.boolean(), optional: z.boolean().optional() });

export const Harness = z.strictObject({
  hostExecutable: z.string().optional(),
  hostDir: z.string().optional(),
  npmPackage: z.string().optional(),
  npmBin: z.string().optional(),
  arguments: Strings,
  environment: z.record(z.string(), z.string()),
  /** Appended when the agent is restarted in place (e.g. after an account switch) so it resumes the conversation. */
  resumeArguments: Strings.optional(),
})
  .refine((h) => h.hostExecutable || h.npmPackage, 'needs hostExecutable or npmPackage')
  .refine((h) => !h.npmPackage || h.npmBin, 'needs npmBin when npmPackage is set');

const Sandbox = z.strictObject({
  memoryMb: z.union([z.literal('auto'), z.number().int().min(2048)]),
  maxMemoryMb: z.number().int().positive(),
  reserveHostMb: z.number().int().nonnegative(),
  vGpu: z.boolean(), networking: z.boolean(), clipboard: z.boolean(), audioInput: z.boolean(), videoInput: z.boolean(),
  printerRedirection: z.boolean(), protectedClient: z.boolean(), headless: z.boolean(),
});
const Git = z.strictObject({ enabled: z.boolean(), access: GitAccess });
const Provisioning = z.strictObject({ copyFromHost: z.boolean(), fallbackToInstall: z.boolean(), refresh: z.boolean(), git: Git, terminal: Toggle });
const Toolchains = z.strictObject({
  node: z.strictObject({ version: z.string().min(1), extraVersions: Strings }),
  python: z.strictObject({ enabled: z.boolean(), version: z.string().min(1), python2: z.boolean() }),
  rust: z.strictObject({ enabled: z.boolean(), toolchain: z.string().min(1), host: z.string().min(1) }),
  cpp: Toggle, dotnet: z.strictObject({ enabled: z.boolean(), channels: Strings }), bun: Toggle, uv: Toggle, vscode: Toggle,
});
const ClaudeProfile = z.strictObject({
  enabled: z.boolean(), hostDir: z.string(), include: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)), globalStateFile: z.string(),
  copyCredentials: z.boolean(), overwrite: z.boolean(), syncHistory: z.boolean(), syncClaudeMem: z.boolean(),
});

export const Config = z.strictObject({
  defaultHarness: Name,
  guestWorkspace: z.union([z.literal('auto'), GuestPath]),
  readOnly: z.boolean(),
  mappings: z.array(Mapping),
  sandbox: Sandbox,
  storage: z.strictObject({ root: z.string().min(1), persistAgentState: z.boolean(), dataName: Name }),
  network: z.strictObject({ blockPrivateRanges: z.boolean() }),
  provisioning: Provisioning,
  toolchains: Toolchains,
  attach: Toggle,
  personalization: Toggle,
  claudeProfile: ClaudeProfile,
  harnesses: z.record(Name, Harness),
  hooks: z.strictObject({ failFast: z.boolean() }),
}).refine((c) => c.harnesses[c.defaultHarness] !== undefined, { message: 'defaultHarness must be one of the configured harnesses', path: ['defaultHarness'] });

/**
 * What a project's .sandbox-config.json may change. A repo can ship this file, so it can NOT touch storage, agent
 * executables, host folders for tools or Claude settings, or anything else outside this list.
 */
export const LocalOverrides = z.strictObject({
  harness: Name,
  guestWorkspace: z.union([z.literal('auto'), GuestPath]),
  readOnly: z.boolean(),
  mappings: z.array(Mapping),
  scripts: Strings,
  sandbox: Sandbox.partial(),
  network: z.strictObject({ blockPrivateRanges: z.boolean() }).partial(),
  provisioning: Provisioning.pick({ copyFromHost: true, fallbackToInstall: true, refresh: true }).extend({ git: Git.partial(), terminal: Toggle.partial() }).partial(),
  toolchains: z.strictObject({
    node: Toolchains.shape.node.partial(), python: Toolchains.shape.python.partial(), rust: Toolchains.shape.rust.partial(),
    cpp: Toggle.partial(), dotnet: Toolchains.shape.dotnet.partial(), bun: Toggle.partial(), uv: Toggle.partial(), vscode: Toggle.partial(),
  }).partial(),
  attach: Toggle.partial(),
  personalization: Toggle.partial(),
  claudeProfile: ClaudeProfile.pick({ enabled: true, include: true, overwrite: true, copyCredentials: true, syncHistory: true, syncClaudeMem: true }).partial(),
  hooks: z.strictObject({ failFast: z.boolean() }).partial(),
}).partial();

/** One readable line per problem: "sandbox.memoryMb: Too small: expected number to be >=2048". */
export const describeIssues = (error: z.ZodError): string[] => error.issues.map((issue) => {
  const at = issue.path.join('.');
  if (issue.code === 'unrecognized_keys') return issue.keys.map((k) => (at ? at + '.' : '') + k + ' is not allowed here').join('; ');
  return (at || 'value') + ': ' + issue.message;
});

export type ConfigT = z.output<typeof Config>;
export type OverridesT = z.output<typeof LocalOverrides>;
