import fs from 'node:fs';
import path from 'node:path';
import type { Config, LoadedConfig } from './types.js';
import { assertGuestPath, fail, homeDir, readJson } from './util.js';

export const DEFAULTS: Config = {
  defaultHarness: 'claude',
  guestWorkspace: 'auto',
  readOnly: false,
  mappings: [],
  sandbox: { memoryMb: 'auto', maxMemoryMb: 32768, reserveHostMb: 8192, vGpu: true, networking: true, clipboard: true, audioInput: false, videoInput: false, printerRedirection: false, protectedClient: true, headless: false },
  storage: { root: '%LOCALAPPDATA%\\AgentSandbox', persistAgentState: true, dataName: 'default' },
  network: { blockPrivateRanges: true },
  provisioning: { copyFromHost: true, fallbackToInstall: true, refresh: false, git: { enabled: true }, terminal: { enabled: true } },
  toolchains: {
    node: { version: 'host', extraVersions: [] },
    python: { enabled: true, version: '3', python2: true },
    rust: { enabled: true, toolchain: 'stable', host: 'x86_64-pc-windows-gnu' },
    cpp: { enabled: true },
    dotnet: { enabled: true, channels: ['LTS'] },
    bun: { enabled: true },
    uv: { enabled: true },
  },
  attach: { enabled: true },
  personalization: { enabled: true },
  claudeProfile: { enabled: true, hostDir: 'auto', include: ['settings.json', 'CLAUDE.md', 'commands', 'agents', 'skills', 'plugins'], globalStateFile: 'auto', copyCredentials: false, overwrite: true, syncHistory: true, syncClaudeMem: true },
  harnesses: {
    claude: { hostExecutable: 'claude.exe', hostDir: 'auto', npmPackage: '@anthropic-ai/claude-code@latest', npmBin: 'claude', arguments: [], environment: { DISABLE_AUTOUPDATER: '1' }, resumeArguments: ['--continue'] },
    codex: { npmPackage: '@openai/codex@latest', npmBin: 'codex', arguments: [], environment: {}, resumeArguments: ['resume', '--last'] },
    gemini: { npmPackage: '@google/gemini-cli@latest', npmBin: 'gemini', arguments: [], environment: {} },
  },
  hooks: { failFast: false },
};

/** Per-user folder for config, hooks and the account store pointer. Survives reinstalling the npm package. */
export const userDir = (): string => process.env.AGENT_SANDBOX_HOME ?? path.join(homeDir(), '.agent-sandbox');
export const userConfigPath = (): string => path.join(userDir(), 'config.json');

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const mergeConfig = <T>(base: T, extra: unknown): T => {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (!isPlainObject(extra)) return result as T;
  for (const [key, value] of Object.entries(extra)) {
    if (key.startsWith('_') || key.startsWith('$')) continue;
    result[key] = isPlainObject(result[key]) && isPlainObject(value) ? mergeConfig(result[key], value) : value;
  }
  return result as T;
};

export const validateConfig = (config: Config): void => {
  if (typeof config.storage?.root !== 'string') fail('storage.root must be a string.');
  if (!/^[A-Za-z0-9_-]+$/.test(config.storage.dataName)) fail('storage.dataName may only contain letters, numbers, - and _.');
  const memory = config.sandbox.memoryMb;
  if (memory !== 'auto' && (!Number.isInteger(memory) || memory < 2048)) fail("sandbox.memoryMb must be 'auto' or an integer >= 2048.");
  if (!config.harnesses?.[config.defaultHarness]) fail('defaultHarness does not exist: ' + config.defaultHarness);
  if (config.guestWorkspace !== 'auto') assertGuestPath(config.guestWorkspace);
  for (const mapping of config.mappings ?? []) {
    if (typeof mapping.host !== 'string' || typeof mapping.guest !== 'string' || typeof mapping.readOnly !== 'boolean') fail('Every mappings entry needs host, guest and a boolean readOnly.');
    assertGuestPath(mapping.guest);
  }
  for (const [name, harness] of Object.entries(config.harnesses)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) fail('Invalid harness name: ' + name);
    if (!harness.hostExecutable && !harness.npmPackage) fail('Harness ' + name + ' needs hostExecutable or npmPackage.');
    if (harness.npmPackage && !harness.npmBin) fail('Harness ' + name + ' needs npmBin when npmPackage is set.');
  }
};

/**
 * Lookup order: --config, %AGENT_SANDBOX_CONFIG%, ~/.agent-sandbox/config.json, built-in defaults.
 * Whatever file is found is merged over the defaults, so it only needs the keys you want to change.
 */
export const loadConfig = (explicitPath?: string): LoadedConfig => {
  const candidate = explicitPath ?? process.env.AGENT_SANDBOX_CONFIG ?? userConfigPath();
  const full = path.resolve(candidate);
  if (!fs.existsSync(full)) {
    if (explicitPath || process.env.AGENT_SANDBOX_CONFIG) fail('Config not found: ' + full);
    const config = structuredClone(DEFAULTS);
    validateConfig(config);
    return { config, configPath: null, base: userDir() };
  }
  const config = mergeConfig(structuredClone(DEFAULTS), readJson<unknown>(full));
  validateConfig(config);
  return { config, configPath: full, base: path.dirname(full) };
};

export const assertNoGuestOverlap = (mappings: { guest: string }[]): void => {
  for (let i = 0; i < mappings.length; i++) {
    for (let j = i + 1; j < mappings.length; j++) {
      const a = mappings[i].guest.replace(/\\+$/, '').toLowerCase();
      const b = mappings[j].guest.replace(/\\+$/, '').toLowerCase();
      if (a === b || a.startsWith(b + '\\') || b.startsWith(a + '\\')) fail('Overlapping guest mappings: ' + mappings[i].guest + ' and ' + mappings[j].guest);
    }
  }
};
