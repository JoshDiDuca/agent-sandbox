// Release assets of the single-download tools (PowerShell 7, cargo-binstall and the small CLI catalogue). Pure: no
// environment, no I/O, so the host and the tests can import it without loading the guest runtime (like versions.ts).
import type { GitAccess } from '../../core/types.js';

export type Arch = 'x64' | 'arm64';

/** PowerShell/PowerShell: the portable zip (PowerShell-7.6.6-win-x64.zip), never the MSI or the fxdependent builds. */
export const pwshAsset = (arch: Arch): RegExp => (arch === 'arm64' ? /^PowerShell-\d+\.\d+\.\d+-win-arm64\.zip$/ : /^PowerShell-\d+\.\d+\.\d+-win-x64\.zip$/);

/** cargo-bins/cargo-binstall: the plain zip (the .full build adds nothing we use; .sig files are signatures). */
export const binstallAsset = (arch: Arch): RegExp => (arch === 'arm64' ? /^cargo-binstall-aarch64-pc-windows-msvc\.zip$/ : /^cargo-binstall-x86_64-pc-windows-msvc\.zip$/);

/**
 * One portable command-line tool from a GitHub release. The archive is unpacked into tools\cli\<name>; without
 * `subdir` only the folder holding `exe` is kept (and goes on PATH), with `subdir` the whole archive stays and that
 * folder inside it goes on PATH (for tools whose exe needs files next to it).
 */
export interface CliTool {
  name: string;
  repo: string;
  asset: (arch: Arch) => RegExp;
  exe: string;
  subdir?: string;
  /** What the tool is for (summary and docs). */
  about: string;
  /** Rough download size for the progress line. */
  size: string;
}

export const CLI_TOOLS = [
  // gh_2.102.0_windows_amd64.zip holds bin\gh.exe.
  { name: 'gh', repo: 'cli/cli', asset: (arch) => (arch === 'arm64' ? /^gh_\d+\.\d+\.\d+_windows_arm64\.zip$/ : /^gh_\d+\.\d+\.\d+_windows_amd64\.zip$/), exe: 'gh.exe', about: 'GitHub CLI', size: '15 MB' },
  // zstd-v1.5.7-win64.zip; there is no arm64 build, and Windows on Arm runs the x64 one.
  { name: 'zstd', repo: 'facebook/zstd', asset: () => /^zstd-v\d+\.\d+\.\d+-win64\.zip$/, exe: 'zstd.exe', about: 'Zstandard compression', size: '2 MB' },
] as const satisfies readonly CliTool[];

export type CliName = (typeof CLI_TOOLS)[number]['name'] | 'openssl';
export const CLI_NAMES: readonly CliName[] = [...CLI_TOOLS.map((t) => t.name), 'openssl'];

/** toolchains.cli: each tool true, false or "auto" (gh: when the project has a .github folder; zstd: never by itself). */
export type CliSettings = Partial<Record<CliName, boolean | 'auto'>>;

export interface CliContext {
  gitAccess: GitAccess;
  /** The workspace has a .github folder (workflows, CODEOWNERS ...). */
  hasGithubDir: boolean;
}

export interface CliDecision { on: boolean; reason: string }

/**
 * Which catalogue tools a sandbox gets. gh is never installed unless git access is "full": gh pushes, merges and edits
 * branches through the GitHub API, so it would walk straight past a "readonly" (or "none") git guard.
 */
export const decideCli = (settings: CliSettings, ctx: CliContext): Record<CliName, CliDecision> => {
  const decide = (name: CliName): CliDecision => {
    const setting = settings[name] ?? false;
    if (name === 'gh' && setting !== false && ctx.gitAccess !== 'full') return { on: false, reason: 'needs provisioning.git.access "full" (gh can push and merge through the GitHub API)' };
    if (setting !== 'auto') return { on: setting, reason: setting ? 'enabled in config' : 'disabled in config' };
    if (name === 'gh' && ctx.hasGithubDir) return { on: true, reason: '.github' };
    // openssl is only a shim onto Git's own copy: free, so "auto" means on.
    if (name === 'openssl') return { on: true, reason: 'Git for Windows ships it' };
    return { on: false, reason: 'not listed in toolchains.cli' };
  };
  return Object.fromEntries(CLI_NAMES.map((name) => [name, decide(name)])) as Record<CliName, CliDecision>;
};
