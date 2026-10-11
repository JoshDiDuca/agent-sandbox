export interface Mapping { host: string; guest: string; readOnly: boolean; optional?: boolean }
export interface Harness { hostExecutable?: string; hostDir?: string; npmPackage?: string; npmBin?: string; arguments: string[]; environment: Record<string, string> }
export interface ClaudeProfileConfig { enabled: boolean; hostDir: string; include: string[]; globalStateFile: string; copyCredentials: boolean; overwrite: boolean }
export interface ProfileResult { hostDir: string | null; staged: string[]; skipped: string[]; credentials: boolean }
export interface Config {
  version: number; defaultHarness: string; guestWorkspace: string; readOnly: boolean; mappings: Mapping[];
  sandbox: { memoryMb: number | 'auto'; maxMemoryMb: number; reserveHostMb: number; vGpu: boolean; networking: boolean; clipboard: boolean; audioInput: boolean; videoInput: boolean; printerRedirection: boolean; protectedClient: boolean };
  storage: { root: string; persistAgentState: boolean; dataName: string };
  network: { blockPrivateRanges: boolean; publicDns: string[] };
  provisioning: { copyFromHost: boolean; fallbackToInstall: boolean; refresh: boolean; node: { version: string; hostDir: string }; git: { enabled: boolean }; terminal: { enabled: boolean; launchAgentInTerminal: boolean } };
  harnesses: Record<string, Harness>; hooks: { failFast: boolean }; claudeProfile: ClaudeProfileConfig;
  projects?: Record<string, Record<string, unknown>>;
}
export interface Overrides {
  harness?: string; guestWorkspace?: string; readOnly?: boolean; mappings?: Mapping[]; scripts?: string[];
  sandbox?: Record<string, unknown>; network?: Record<string, unknown>; provisioning?: Record<string, unknown>; claudeProfile?: Record<string, unknown>; hooks?: Record<string, unknown>;
  workspace?: string; createWorkspace?: boolean;
}
export interface LocalConfigFile { path: string; hash: string; data: unknown }
export interface LoadedConfig { config: Config; configPath: string; base: string }
export interface RunRequest { projectRoot: string; loaded: LoadedConfig; cwd: string; project?: string; workspace?: string; harness?: string; noAgent: boolean; noLocalConfig: boolean; trustConfig: boolean; scripts: string[]; ask?: (question: string) => Promise<boolean> }
export interface ResolvedRun { config: Config; workspaceHost: string; dataName: string; harnessName: string; scripts: string[]; localConfigPath: string | null; notes: string[] }
export interface HostProbe { nodeDir: string | null; harnessExe: { dir: string; file: string } | null }
export interface ResolvedMapping { host: string; guest: string; readOnly: boolean }
export interface GenerateOptions { projectRoot: string; config: Config; base: string; dataName: string; harnessName: string; harnessArgs: string[]; workspaceHost: string; scripts: string[]; probe: HostProbe; freeMemoryBytes?: number }
export interface Generated { wsbPath: string; launchPath: string; sessionPath: string; memoryMb: number; mappings: ResolvedMapping[]; workspaceHost: string; profile: ProfileResult }
export interface CliOptions { command: string; config: string; project?: string; harness?: string; here: boolean; workspace?: string; scripts: string[]; harnessArgs: string[]; shadow: boolean; personal: boolean; noAgent: boolean; noLocalConfig: boolean; trustConfig: boolean }
export interface GuestSession {
  version: number; project: string; workspace: string; harnessName: string; harness: Harness | null; harnessArguments: string[];
  persistAgentState: boolean; networking: boolean; network: Config['network']; provisioning: Config['provisioning'];
  hostTools: { node: boolean; harnessExecutable: string | null }; hooks: Config['hooks'];
  claudeProfile: { overwrite: boolean; items: string[]; credentials: boolean };
}
