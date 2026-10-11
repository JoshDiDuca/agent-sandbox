// The user config and the smaller subset a project's .sandbox-config.json may change. Types are inferred from these
// schemas, and the JSON Schema files in schemas/ are generated from them at build time.
import _ from 'lodash';
import { z } from 'zod';
import { Name, SchemaRef, Strings, toggle } from './common.js';
import { Databases } from './databases.js';
import { Harness } from './harness.js';
import { AgentCommands, Attach, ClaudeProfile, Secrets } from './profile.js';
import { Downloads, Git, GuestWorkspace, Mapping, Provisioning, Sandbox } from './sandbox.js';
import { Toolchains } from './toolchains.js';
import { Projects } from './projects.js';

export const Config = z.strictObject({
  $schema: SchemaRef.optional(),
  defaultHarness: Name.describe('Agent started by `sandbox launch` (sandbox claude always runs claude).'),
  guestWorkspace: GuestWorkspace,
  readOnly: z.boolean().describe('Map the workspace read-only.'),
  mappings: z.array(Mapping).describe('Extra folders from this PC.'),
  sandbox: Sandbox,
  storage: z.strictObject({
    root: z.string().min(1).describe('Where everything is kept on this PC (tools, databases, logins, launches).'),
    persistAgentState: z.boolean().describe('Keep agent logins and history between sandboxes.'),
    dataName: Name.describe('Name of the persistent data set (C:\\AgentData) shared by all workspaces.'),
  }),
  network: z.strictObject({ blockPrivateRanges: z.boolean().describe('Block your LAN (10/8, 172.16/12, 192.168/16, SMB) from inside the sandbox.') }),
  provisioning: Provisioning,
  downloads: Downloads,
  toolchains: Toolchains,
  databases: Databases.describe('Databases running inside the sandbox. Data persists in C:\\AgentData\\databases; each one starts at boot.'),
  attach: Attach,
  agentCommands: AgentCommands,
  secrets: Secrets,
  personalization: toggle('Copy your desktop look (theme, accent, taskbar, wallpaper, ...) into the sandbox.'),
  claudeProfile: ClaudeProfile,
  harnesses: z.record(Name, Harness).describe('Agents that can run in the sandbox.'),
  hooks: z.strictObject({ failFast: z.boolean().describe('Stop when a hook script fails.') }),
  projects: Projects.describe('Several projects in one sandbox: folders of projects mapped at every start, and adding folders while it runs.'),
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
  sandbox: Sandbox.omit({ cpuLimit: true }).partial(),
  network: z.strictObject({ blockPrivateRanges: z.boolean() }).partial(),
  provisioning: Provisioning.pick({ copyFromHost: true, fallbackToInstall: true, refresh: true }).extend({ git: Git.partial(), terminal: toggle('Windows Terminal as the sandbox window.').partial() }).partial(),
  downloads: Downloads.partial(),
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

