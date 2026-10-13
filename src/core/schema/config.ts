// The user config and the smaller subset a project's .sandbox-config.json may change. Types are inferred from these
// schemas, and the JSON Schema files in schemas/ are generated from them at build time.
import _ from 'lodash';
import { z } from 'zod';
import { Name, SchemaRef, Strings, toggle } from './common.js';
import { Databases } from './databases.js';
import { Harness } from './harness.js';
import { AgentCommands, Attach, ClaudeProfile, Secrets } from './profile.js';
import { Audit, Downloads, Git, GuestWorkspace, Mapping, Network, Provisioning, Sandbox, WorkspaceFilter } from './sandbox.js';
import { Toolchains } from './toolchains.js';
import { Apps } from './apps.js';
import { Projects } from './projects.js';

export const Config = z.strictObject({
  $schema: SchemaRef.optional(),
  defaultHarness: Name.describe('Agent started by `sandbox launch` (sandbox claude always runs claude).'),
  guestWorkspace: GuestWorkspace,
  readOnly: z.boolean().describe('Map the workspace read-only.'),
  workspaceFilter: WorkspaceFilter,
  audit: Audit,
  mappings: z.array(Mapping).describe('Extra folders from this PC.'),
  sandbox: Sandbox,
  storage: z.strictObject({
    root: z.string().min(1).describe('Where everything is kept on this PC (tools, databases, logins, launches).'),
    persistAgentState: z.boolean().describe('Keep agent logins and history between sandboxes.'),
    dataName: Name.describe('Name of the persistent data set (C:\\AgentData) shared by all workspaces.'),
    markSandboxFiles: z.boolean().describe('Programs and scripts (.exe, .ps1, .bat, .cmd, .msi, .lnk ...) that appear or change in your project while a sandbox runs get Windows\' "downloaded from the internet" mark, so SmartScreen and PowerShell ask before they run on this PC.'),
    warnDataGb: z.number().min(0).describe('Say at launch when the persisted data (tools, databases, logins) is bigger than this many GB; 0 = never. sandbox data shows what takes the space.'),
  }),
  network: Network,
  provisioning: Provisioning,
  downloads: Downloads,
  toolchains: Toolchains,
  databases: Databases.describe('Databases running inside the sandbox. Data persists in C:\\AgentData\\databases; each one starts at boot.'),
  attach: Attach,
  agentCommands: AgentCommands,
  secrets: Secrets,
  personalization: toggle('Copy your desktop look (theme, accent, taskbar, wallpaper, ...) into the sandbox.'),
  apps: Apps,
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
  // A project may turn the filter on and keep more out, never let ignored files in.
  workspaceFilter: WorkspaceFilter.pick({ enabled: true, exclude: true }).partial(),
  mappings: z.array(Mapping).describe('Extra folders inside this project (relative to this file), e.g. a read-only data folder at another place in the sandbox.'),
  scripts: Strings.describe('Scripts (.ps1 / .mjs / .cmd, relative to this file) run inside the sandbox before the agent.'),
  // This PC's resources are yours to share: CPU and paging file (this PC's disk) are not a project's to set.
  sandbox: Sandbox.omit({ cpuLimit: true, pageFileMb: true }).partial(),
  // A project may block more (the LAN, hosts); it never opens hosts, ports, DNS or a proxy.
  network: Network.pick({ blockPrivateRanges: true, blockHosts: true }).partial(),
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
  // Catalogue apps only (a vetted list): your own programs (apps.custom) download anything, so a repo cannot add them.
  apps: Apps.pick({ install: true }).partial(),
  claudeProfile: ClaudeProfile.pick({ enabled: true, overwrite: true, copyCredentials: true, syncHistory: true, syncClaudeMem: true }).partial(),
  hooks: z.strictObject({ failFast: z.boolean() }).partial(),
}).partial();

