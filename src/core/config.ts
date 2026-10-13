// Built-in defaults and loading the user config (~/.agent-sandbox/config.json). Shapes live in schema.ts.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import type { Config, LoadedConfig } from './types.js';
import { Config as ConfigSchema, describeIssues } from './schema.js';
import { fail, homeDir, readJsonc } from './util.js';

export const DEFAULTS: Config = {
  defaultHarness: 'claude',
  guestWorkspace: 'auto',
  readOnly: false,
  mappings: [],
  sandbox: { memoryMb: 'auto', maxMemoryMb: 32768, maxMemoryPercent: 80, cpuLimit: 80, reserveHostMb: 8192, vGpu: false, networking: true, clipboard: true, audioInput: false, videoInput: false, printerRedirection: false, protectedClient: true, headless: false },
  storage: { root: '%LOCALAPPDATA%\\AgentSandbox', persistAgentState: true, dataName: 'default' },
  network: { blockPrivateRanges: true },
  provisioning: { copyFromHost: true, fallbackToInstall: true, refresh: false, git: { enabled: true, access: 'full' }, terminal: { enabled: true }, conpty: { enabled: true } },
  downloads: { requireChecksum: false },
  toolchains: {
    node: { version: 'host', extraVersions: [], corepack: true, volta: 'auto', globalPackages: [] },
    python: { enabled: 'auto', version: '3', python2: true, pyenv: 'auto', tools: [] },
    rust: { enabled: 'auto', toolchain: 'stable', host: 'auto', components: [], targets: [], crates: [], targetDir: 'separate' },
    msvc: { enabled: 'auto', acceptLicense: false, msvcVersion: 'latest', sdkVersion: 'latest' },
    cpp: { enabled: 'auto', flexBison: true },
    dotnet: { enabled: 'auto', channels: ['LTS'], tools: [], workloads: [], frameworkTargets: ['net48', 'net472'], netfx35: false },
    // Bigger downloads only for projects that use them.
    go: { enabled: 'auto', version: 'stable', tools: [] },
    java: { enabled: 'auto', version: 'lts', maven: true, gradle: true },
    ruby: { enabled: 'auto', version: '3', gems: [] },
    php: { enabled: 'auto', version: '8', composer: true },
    deno: { enabled: 'auto' },
    pwsh: { enabled: 'auto' },
    cli: { gh: 'auto', zstd: false, openssl: 'auto' },
    bun: { enabled: true },
    uv: { enabled: true },
    vcRuntime: { enabled: false },
    mesa: { enabled: false, vulkan: false },
    vscode: { enabled: true, setup: true, recommended: true, extensions: [] },
    environment: {},
  },
  databases: {
    postgres: { enabled: 'auto', version: 'latest', port: 5432 },
    mysql: { enabled: 'auto', version: 'lts', port: 3306 },
    mongodb: { enabled: 'auto', version: 'latest', port: 27017 },
    redis: { enabled: 'auto', port: 6379 },
    dynamodb: { enabled: 'auto', port: 8000, adminPort: 8001, admin: true },
    sqlserver: { enabled: 'auto' },
  },
  attach: { enabled: true, reuseSession: true, auto: false, autoHide: false },
  agentCommands: { enabled: false, agents: 'auto' },
  secrets: { strip: true, allow: [], patterns: [], warnFiles: true },
  personalization: { enabled: true },
  apps: { install: [], custom: {} },
  claudeProfile: { enabled: true, hostDir: 'auto', include: ['settings.json', 'CLAUDE.md', 'commands', 'agents', 'skills', 'plugins'], globalStateFile: 'auto', copyCredentials: false, overwrite: true, syncHistory: true, syncClaudeMem: true },
  harnesses: {
    claude: { hostExecutable: 'claude.exe', hostDir: 'auto', npmPackage: '@anthropic-ai/claude-code@latest', npmBin: 'claude', arguments: [], environment: { DISABLE_AUTOUPDATER: '1' }, resumeArguments: ['--continue'] },
    codex: { npmPackage: '@openai/codex@latest', npmBin: 'codex', arguments: [], environment: {}, resumeArguments: ['resume', '--last'] },
    gemini: { npmPackage: '@google/gemini-cli@latest', npmBin: 'gemini', arguments: [], environment: {}, resumeArguments: ['--resume'] },
    // Not tested by us; installed from each project's official npm / PyPI package.
    opencode: { npmPackage: 'opencode-ai@latest', npmBin: 'opencode', arguments: [], environment: {}, resumeArguments: ['--continue'] },
    qwen: { npmPackage: '@qwen-code/qwen-code@latest', npmBin: 'qwen', arguments: [], environment: {}, resumeArguments: ['--continue'] },
    crush: { npmPackage: '@charmland/crush@latest', npmBin: 'crush', arguments: [], environment: {}, resumeArguments: ['--continue'] },
    copilot: { npmPackage: '@github/copilot@latest', npmBin: 'copilot', arguments: [], environment: {}, resumeArguments: ['--continue'] },
    kilo: { npmPackage: '@kilocode/cli@latest', npmBin: 'kilo', arguments: [], environment: {}, resumeArguments: ['--continue'] },
    amp: { npmPackage: '@ampcode/cli@latest', npmBin: 'amp', arguments: [], environment: {} },
    cline: { npmPackage: 'cline@latest', npmBin: 'cline', arguments: [], environment: {} },
    continue: { npmPackage: '@continuedev/cli@latest', npmBin: 'cn', arguments: [], environment: {}, resumeArguments: ['--resume'] },
    kimi: { npmPackage: '@moonshot-ai/kimi-code@latest', npmBin: 'kimi', arguments: [], environment: {}, resumeArguments: ['-c'] },
    // DeepSeek has no official coding CLI; these two community agents are built for it.
    reasonix: { npmPackage: 'reasonix@latest', npmBin: 'reasonix', arguments: [], environment: {} },
    deepseek: { npmPackage: 'codewhale@latest', npmBin: 'codewhale', arguments: [], environment: {} },
    aider: { uvPackage: 'aider-chat', uvBin: 'aider', arguments: [], environment: {}, resumeArguments: ['--restore-chat-history'] },
  },
  hooks: { failFast: false },
  projects: { all: false, exclude: [], roots: [], askToAddRoot: true, declinedRoots: [], wsbShare: true },
};

/** Per-user folder for config and hooks. Survives reinstalling the npm package. */
export const userDir = (): string => process.env.AGENT_SANDBOX_HOME ?? path.join(homeDir(), '.agent-sandbox');
export const userConfigPath = (): string => path.join(userDir(), 'config.json');

/** Deep merge where arrays (and anything that is not a plain object) replace instead of merging element by element. */
export const mergeConfig = <T>(base: T, extra: unknown): T =>
  _.mergeWith(_.cloneDeep(base), extra, (_target: unknown, source: unknown) => (Array.isArray(source) ? source : undefined));

/** Validates a full config; throws one readable error listing every problem. */
export const validateConfig = (config: unknown, source: string): Config => {
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) fail(source + ' is not valid:\n  - ' + describeIssues(parsed.error).join('\n  - '));
  return parsed.data;
};

/**
 * Lookup order: --config, %AGENT_SANDBOX_CONFIG%, ~/.agent-sandbox/config.json, built-in defaults.
 * Whatever file is found (JSON with comments) is merged over the defaults, so it only needs the keys you change.
 */
export const loadConfig = (explicitPath?: string): LoadedConfig => {
  const requested = explicitPath ?? process.env.AGENT_SANDBOX_CONFIG;
  const full = path.resolve(requested ?? userConfigPath());
  if (!fs.existsSync(full)) {
    if (requested) fail('Config file not found: ' + full, 'Check the --config path or AGENT_SANDBOX_CONFIG, or create one with: sandbox config init');
    return { config: structuredClone(DEFAULTS), configPath: null, base: userDir() };
  }
  return { config: validateConfig(mergeConfig(DEFAULTS, readJsonc<unknown>(full)), full), configPath: full, base: path.dirname(full) };
};

export const assertNoGuestOverlap = (mappings: { guest: string }[]): void => {
  const normal = mappings.map((m) => m.guest.replace(/\\+$/, '').toLowerCase());
  normal.forEach((a, i) => normal.slice(i + 1).forEach((b, j) => {
    if (a === b || a.startsWith(b + '\\') || b.startsWith(a + '\\')) fail('Two folders map to overlapping places in the sandbox: ' + mappings[i].guest + ' and ' + mappings[i + 1 + j].guest + '.', 'Give each mapping its own guest folder (one must not be inside the other).');
  }));
};
