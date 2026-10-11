export interface Mapping { host: string; guest: string; readOnly: boolean; optional?: boolean }
export interface ResolvedMapping { host: string; guest: string; readOnly: boolean }

export interface Harness {
  hostExecutable?: string; hostDir?: string; npmPackage?: string; npmBin?: string;
  arguments: string[]; environment: Record<string, string>;
  /** Appended when the agent is restarted in place (e.g. after an account switch) so it resumes the conversation. */
  resumeArguments?: string[];
}

export interface ClaudeProfileConfig {
  enabled: boolean; hostDir: string; include: string[]; globalStateFile: string; copyCredentials: boolean; overwrite: boolean;
  /** Bring ALL conversation history into the sandbox and sync new history back to this PC. */
  syncHistory: boolean;
  /** Bring the claude-mem plugin data (~/.claude-mem) into the sandbox and sync it back. */
  syncClaudeMem: boolean;
}

export interface Toolchains {
  node: { version: string; extraVersions: string[] };
  python: { enabled: boolean; version: string; python2: boolean };
  rust: { enabled: boolean; toolchain: string; host: string };
  /** MinGW-w64 GCC (gcc, g++, mingw32-make); also the linker for Rust's GNU host. */
  cpp: { enabled: boolean };
  dotnet: { enabled: boolean; channels: string[] };
  bun: { enabled: boolean };
  uv: { enabled: boolean };
}

export interface Config {
  defaultHarness: string; guestWorkspace: string; readOnly: boolean; mappings: Mapping[];
  sandbox: { memoryMb: number | 'auto'; maxMemoryMb: number; reserveHostMb: number; vGpu: boolean; networking: boolean; clipboard: boolean; audioInput: boolean; videoInput: boolean; printerRedirection: boolean; protectedClient: boolean; headless: boolean };
  storage: { root: string; persistAgentState: boolean; dataName: string };
  network: { blockPrivateRanges: boolean };
  provisioning: { copyFromHost: boolean; fallbackToInstall: boolean; refresh: boolean; git: { enabled: boolean }; terminal: { enabled: boolean } };
  toolchains: Toolchains;
  attach: { enabled: boolean };
  personalization: { enabled: boolean };
  claudeProfile: ClaudeProfileConfig;
  harnesses: Record<string, Harness>;
  hooks: { failFast: boolean };
}

/** Settings a folder's .sandbox-config.json may change (validated; never host paths or executables). */
export interface Overrides {
  harness?: string; guestWorkspace?: string; readOnly?: boolean; mappings?: Mapping[]; scripts?: string[];
  sandbox?: Record<string, unknown>; network?: Record<string, unknown>; provisioning?: Record<string, unknown>;
  toolchains?: Record<string, unknown>; attach?: Record<string, unknown>; personalization?: Record<string, unknown>;
  claudeProfile?: Record<string, unknown>; hooks?: Record<string, unknown>;
}

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
}

export interface GenerateOptions {
  packageRoot: string; run: ResolvedRun; harnessArgs: string[]; probe: HostProbe; freeMemoryBytes?: number;
}
export interface Generated {
  wsbPath: string; launchPath: string; launchId: string; sessionPath: string; memoryMb: number;
  mappings: ResolvedMapping[]; profile: ProfileResult;
}
export interface ProfileResult { hostDir: string | null; staged: string[]; skipped: string[]; credentials: boolean }

/** Written to C:\AgentLaunch\session.json; everything the guest needs to know. */
export interface GuestSession {
  launchId: string; project: string; workspace: string; workspaceHost: string;
  harnessName: string; harness: Harness | null; harnessArguments: string[];
  persistAgentState: boolean; networking: boolean; headless: boolean;
  network: Config['network']; provisioning: Config['provisioning']; toolchains: Config['toolchains']; versions: ToolVersions;
  attach: Config['attach']; hooks: Config['hooks'];
  hostTools: { node: boolean; harnessExecutable: string | null; git: boolean; nvm: boolean };
  claudeProfile: { overwrite: boolean; items: string[]; credentials: boolean; hostConfigDir: string | null; syncClaudeMem: boolean };
  personalization: boolean;
}

export interface AttachEndpoint { addresses: string[]; port: number; token: string }

/** C:\AgentData\run\sandbox.json — boot progress of the sandbox as a whole. */
export interface SandboxStatus {
  launchId: string; phase: 'booting' | 'provisioning' | 'ready' | 'failed';
  message: string; updatedAt: string; workspaceHost: string; guestWorkspace: string; headless: boolean;
}

/**
 * C:\AgentData\run\requests\<id>.json — the ONLY way the host asks the sandbox to do something. The guest daemon
 * accepts exactly these kinds; anything else is rejected. Requests flow host -> guest only.
 */
export type GuestRequest =
  | { kind: 'session'; id: string; harness: string; args: string[]; cwd: string; createdAt: string }
  | { kind: 'exec'; id: string; command: string[]; cwd: string; timeoutSeconds: number; createdAt: string }
  | { kind: 'restart'; id: string; harness: string | null; createdAt: string }
  | { kind: 'ping'; id: string; createdAt: string };

/** C:\AgentData\run\responses\<id>.json — the guest's reply. Treated by the host as untrusted data (validated, capped). */
export interface GuestResponse { id: string; ok: boolean; message: string; exitCode?: number; stdout?: string; stderr?: string; finishedAt: string }

/** C:\AgentData\run\sessions\<id>.json — one agent session (its own pseudo console and terminal tab). */
export interface SessionStatus {
  id: string; launchId: string; harness: string; cwd: string; phase: 'starting' | 'running' | 'exited' | 'failed';
  message: string; updatedAt: string; startedAt: string; exitCode?: number; attach?: AttachEndpoint;
}
