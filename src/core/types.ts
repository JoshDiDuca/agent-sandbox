// Shared types. Config and channel types come straight from the zod schemas, so each shape is defined exactly once.
import type { z } from 'zod';
import type { AutoToolchain, ToolchainDecision } from './detect/index.js';
import type { BootWant } from './local-config/index.js';
import type {
  ConfigSchema,
  GitAccessSchema,
  HarnessSchema,
  LocalOverridesSchema,
  MappingSchema,
} from './schema/index.js';

export type {
  AttachEndpoint,
  GuestRequest,
  GuestResponse,
  SandboxStatus,
  SessionStatus,
} from '../shared/channel/index.js';

export type Config = z.output<typeof ConfigSchema>;
export type Overrides = z.output<typeof LocalOverridesSchema>;
export type GitAccess = z.output<typeof GitAccessSchema>;
export type Harness = z.output<typeof HarnessSchema>;
export type Mapping = z.output<typeof MappingSchema>;
export type Toolchains = Config['toolchains'];
export type ClaudeProfileConfig = Config['claudeProfile'];

/** label: shown in the launch table, e.g. "outside the project, allowed". */
export interface ResolvedMapping {
  host: string;
  guest: string;
  readOnly: boolean;
  label?: string;
}
export interface LocalConfigFile {
  path: string;
  hash: string;
  data: unknown;
}
export interface LoadedConfig {
  config: Config;
  configPath: string | null;
  base: string;
}

export interface RunRequest {
  packageRoot: string;
  loaded: LoadedConfig;
  cwd: string;
  workspace?: string;
  harness?: string;
  noAgent: boolean;
  noLocalConfig: boolean;
  trustConfig: boolean;
  scripts: string[];
  headless?: boolean;
  /** --database: start these whatever the config and detection say. */
  databases?: string[];
  nodeVersion?: string;
  pythonVersion?: string;
  ask?: (question: string) => Promise<boolean>;
  /** `ask` can reach you (default: stdin is a terminal). Tests set it. */
  interactive?: boolean;
}
export interface ResolvedRun {
  config: Config;
  storageRoot: string;
  dataPath: string;
  workspaceHost: string;
  harnessName: string;
  scripts: string[];
  localConfigPath: string | null;
  notes: string[];
  versions: ToolVersions;
  /** Your config asks for guestWorkspace "mirror" (project roots then appear at their PC paths too). */
  mirror?: boolean;
  /** The project file's folders outside the project that you allowed (host paths; the launch table marks them). */
  outsideMappings?: string[];
}

/** A requested version plus where the request came from (shown to the user). */
export interface VersionSpec {
  spec: string;
  source: string;
}
export interface ToolVersions {
  node: VersionSpec;
  nodeExtra: string[];
  python: VersionSpec;
}

export interface HostProbe {
  nodeDir: string | null;
  harnessExe: { dir: string; file: string } | null;
  gitDir: string | null;
  nvmDir: string | null;
  hostNodeVersion: string;
  /** This PC's Node is one of nvm's versions, so it comes in with nvm and nodeDir stays unmapped. */
  nvmNode?: boolean;
  /** This PC has Volta / pyenv-win (VOLTA_HOME / PYENV set). */
  volta?: boolean;
  pyenv?: boolean;
}

/** A database the sandbox runs, and why ("compose.yaml: a compose service runs Postgres"). */
export interface DatabasePlan {
  database: 'postgres' | 'mysql' | 'sqlserver' | 'mongodb' | 'redis' | 'dynamodb';
  reasons: string[];
  version: string;
  port: number;
  adminPort?: number;
}

/** databases / pcLanguages: use these instead of scanning (tests). */
export interface GenerateOptions {
  packageRoot: string;
  run: ResolvedRun;
  harnessArgs: string[];
  probe: HostProbe;
  freeMemoryBytes?: number;
  databases?: DatabasePlan[];
  pcLanguages?: AutoToolchain[];
  /**
   * More projects to map (a restart that adds one keeps the ones in use); knownProjects: instead of known-projects.json
   * (tests).
   */
  extraProjects?: string[];
  knownProjects?: string[];
  /** false: no agent session at boot. */
  autoSession?: boolean;
  /** The other projects mapped at boot with their effective configs: the sandbox boots with what they want too. */
  bootWants?: { projects: BootWant[]; keepOff: string[] };
}
export interface Generated {
  wsbPath: string;
  launchPath: string;
  launchId: string;
  sessionPath: string;
  memoryMb: number;
  /** The config the sandbox boots with: the launch folder's plus what the other projects mapped at boot want. */
  bootConfig: Config;
  /** Boot settings turned on for another project (setting -> project). */
  widened: Record<string, string>;
  mappings: ResolvedMapping[];
  profile: ProfileResult;
  databases: DatabasePlan[];
  /** Project roots and other projects mapped with the launch folder. */
  projects: { roots: { host: string; guest: string }[]; projects: { host: string; guest: string }[]; notes: string[] };
  toolchains: Record<AutoToolchain, ToolchainDecision>;
  /** Where extra folders went when their own path could not be used, and the optional ones skipped. */
  mappingNotes: string[];
}
/** secretsRemoved: what secrets.strip kept on this PC, e.g. "settings.json env.AWS_SECRET_ACCESS_KEY". */
export interface ProfileResult {
  hostDir: string | null;
  staged: string[];
  skipped: string[];
  credentials: boolean;
  secretsRemoved: string[];
}

/** Written by the host to C:\AgentLaunch\session.json (read-only for the guest): everything the guest needs to know. */
export interface GuestSession {
  launchId: string;
  project: string;
  workspace: string;
  workspaceHost: string;
  /**
   * The launch folder's project id (file-name safe; status files and sessions use it). Older launch folders lack it.
   */
  projectId?: string;
  /**
   * Where project roots appear (C:\Projects), and the guest folders of the roots and the projects mapped at boot. Older
   * launch folders lack them.
   */
  projectsDir?: string;
  roots?: string[];
  /** false: start no agent session at boot (a restart that adds a project opens its sessions itself). */
  autoSession?: boolean;
  harnessName: string;
  harness: Harness | null;
  harnessArguments: string[];
  persistAgentState: boolean;
  networking: boolean;
  headless: boolean;
  network: Config['network'];
  provisioning: Config['provisioning'];
  toolchains: Toolchains;
  databases: DatabasePlan[];
  versions: ToolVersions;
  /** Every database `sbx-db start` can run later (older launch folders lack it). */
  databaseCatalog?: DatabasePlan[];
  attach: Config['attach'];
  hooks: Config['hooks'];
  downloads: Config['downloads'];
  /** nodeVersion: this PC's Node (e.g. 22.11.0), found under nvm\v<version> when nvm is mapped, else under node. */
  /** volta / pyenv: this PC uses them (their "auto" settings turn them on in the sandbox too). */
  hostTools: {
    node: boolean;
    nodeVersion: string | null;
    harnessExecutable: string | null;
    git: boolean;
    nvm: boolean;
    volta?: boolean;
    pyenv?: boolean;
  };
  claudeProfile: {
    overwrite: boolean;
    items: string[];
    credentials: boolean;
    hostConfigDir: string | null;
    syncClaudeMem: boolean;
  };
  personalization: boolean;
  /**
   * Drives other than C: that bootstrap.ps1 makes with subst before anything uses them: letter D-Z onto
   * C:\Mirror\<letter>.
   */
  substDrives?: { letter: string; target: string }[];
  /**
   * sandbox.cpuLimit as a number (null = no cap); sandbox\scripts\set-cpu-cap.ps1 applies it before anything starts.
   */
  cpuLimitPercent?: number | null;
  /** sandbox.pageFileMb (0 = Windows' own); sandbox\scripts\set-page-file.ps1 applies it at logon. */
  pageFileMb?: number;
  /** Apps to install (catalogue ids and your own programs); missing in launch folders of older versions. */
  apps?: Config['apps'];
  /** audit.enabled and audit.processes: the sandbox reports the programs it starts (host keeps the log). */
  auditProcesses?: boolean;
  /** Every agent's home variables (CODEX_HOME ...) -> folder below the state folder; older launch folders lack it. */
  agentHomes?: Record<string, string>;
  /** Per agent: folders of the user profile (.qwen ...) linked into the persistent state at boot. */
  agentProfileDirs?: Record<string, string[]>;
}
