export interface Mapping { host: string; guest: string; readOnly: boolean; optional?: boolean }
export interface Harness { hostExecutable?: string; hostDir?: string; npmPackage?: string; npmBin?: string; arguments: string[]; environment: Record<string, string> }
export interface Project { workspace: string; createWorkspace: boolean; guestWorkspace: string; readOnly: boolean; mappings: Mapping[] }
export interface Config {
  version: number; defaultProject: string; defaultHarness: string;
  sandbox: { memoryMb: number | 'auto'; maxMemoryMb: number; reserveHostMb: number; vGpu: boolean; networking: boolean; clipboard: boolean; audioInput: boolean; videoInput: boolean; printerRedirection: boolean; protectedClient: boolean };
  storage: { root: string; persistAgentState: boolean };
  network: { blockPrivateRanges: boolean; publicDns: string[] };
  provisioning: { copyFromHost: boolean; fallbackToInstall: boolean; refresh: boolean; node: { version: string; hostDir: string }; git: { enabled: boolean }; terminal: { enabled: boolean; launchAgentInTerminal: boolean } };
  projects: Record<string, Project>; harnesses: Record<string, Harness>; hooks: { failFast: boolean }; claudeProfile: ClaudeProfileConfig;
}
export interface ClaudeProfileConfig { enabled: boolean; hostDir: string; include: string[]; globalStateFile: string; copyCredentials: boolean; overwrite: boolean }
export interface ProfileResult { hostDir: string | null; staged: string[]; skipped: string[]; credentials: boolean }
export interface LoadedConfig { config: Config; configPath: string; base: string }
export interface HostProbe { nodeDir: string | null; harnessExe: { dir: string; file: string } | null }
export interface ResolvedMapping { host: string; guest: string; readOnly: boolean }
export interface GenerateOptions { projectRoot: string; config: Config; base: string; projectName: string; harnessName: string; harnessArgs: string[]; workspaceOverride?: string; scripts: string[]; probe: HostProbe; freeMemoryBytes?: number }
export interface Generated { wsbPath: string; launchPath: string; sessionPath: string; memoryMb: number; mappings: ResolvedMapping[]; workspaceHost: string; profile: ProfileResult }
export interface CliOptions { command: string; config: string; project?: string; harness?: string; here: boolean; workspace?: string; scripts: string[]; harnessArgs: string[]; shadow: boolean; personal: boolean; noAgent: boolean }
export interface GuestSession {
  version: number; project: string; workspace: string; harnessName: string; harness: Harness | null; harnessArguments: string[];
  persistAgentState: boolean; networking: boolean; network: Config['network']; provisioning: Config['provisioning'];
  hostTools: { node: boolean; harnessExecutable: string | null }; hooks: Config['hooks'];
  claudeProfile: { overwrite: boolean; items: string[]; credentials: boolean };
}
