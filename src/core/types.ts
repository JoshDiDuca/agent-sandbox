// Shared types. Config and channel types come straight from the zod schemas, so each shape is defined exactly once.
import type { z } from 'zod';
import type { Config as ConfigSchema, GitAccess as GitAccessSchema, Harness as HarnessSchema, LocalOverrides, Mapping as MappingSchema } from './schema.js';

export type { AttachEndpointT as AttachEndpoint, GuestRequestT as GuestRequest, GuestResponseT as GuestResponse, SandboxStatusT as SandboxStatus, SessionStatusT as SessionStatus } from '../shared/schema.js';

export type Config = z.output<typeof ConfigSchema>;
export type Overrides = z.output<typeof LocalOverrides>;
export type GitAccess = z.output<typeof GitAccessSchema>;
export type Harness = z.output<typeof HarnessSchema>;
export type Mapping = z.output<typeof MappingSchema>;
export type Toolchains = Config['toolchains'];
export type ClaudeProfileConfig = Config['claudeProfile'];

export interface ResolvedMapping { host: string; guest: string; readOnly: boolean }
export interface LocalConfigFile { path: string; hash: string; data: unknown }
export interface LoadedConfig { config: Config; configPath: string | null; base: string }

export interface RunRequest {
  packageRoot: string; loaded: LoadedConfig; cwd: string; workspace?: string; harness?: string;
  noAgent: boolean; noLocalConfig: boolean; trustConfig: boolean; scripts: string[]; headless?: boolean;
  nodeVersion?: string; pythonVersion?: string;
  ask?: (question: string) => Promise<boolean>;
}
export interface ResolvedRun {
  config: Config; storageRoot: string; dataPath: string; workspaceHost: string; harnessName: string; scripts: string[];
  localConfigPath: string | null; notes: string[]; versions: ToolVersions;
}

/** A requested version plus where the request came from (shown to the user). */
export interface VersionSpec { spec: string; source: string }
export interface ToolVersions { node: VersionSpec; nodeExtra: string[]; python: VersionSpec }

export interface HostProbe {
  nodeDir: string | null; harnessExe: { dir: string; file: string } | null;
  gitDir: string | null; nvmDir: string | null; hostNodeVersion: string;
  /** This PC's Node is one of nvm's versions, so it comes in with nvm and nodeDir stays unmapped. */
  nvmNode?: boolean;
}

export interface GenerateOptions { packageRoot: string; run: ResolvedRun; harnessArgs: string[]; probe: HostProbe; freeMemoryBytes?: number }
export interface Generated {
  wsbPath: string; launchPath: string; launchId: string; sessionPath: string; memoryMb: number;
  mappings: ResolvedMapping[]; profile: ProfileResult;
}
export interface ProfileResult { hostDir: string | null; staged: string[]; skipped: string[]; credentials: boolean }

/** Written by the host to C:\AgentLaunch\session.json (read-only for the guest): everything the guest needs to know. */
export interface GuestSession {
  launchId: string; project: string; workspace: string; workspaceHost: string;
  harnessName: string; harness: Harness | null; harnessArguments: string[];
  persistAgentState: boolean; networking: boolean; headless: boolean;
  network: Config['network']; provisioning: Config['provisioning']; toolchains: Toolchains; versions: ToolVersions;
  attach: Config['attach']; hooks: Config['hooks'];
  /** nodeVersion: this PC's Node (e.g. 22.11.0), found under nvm\v<version> when nvm is mapped, else under node. */
  hostTools: { node: boolean; nodeVersion: string | null; harnessExecutable: string | null; git: boolean; nvm: boolean };
  claudeProfile: { overwrite: boolean; items: string[]; credentials: boolean; hostConfigDir: string | null; syncClaudeMem: boolean };
  personalization: boolean;
}
