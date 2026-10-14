import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import type { Config, LoadedConfig } from '../types.js';
import { ConfigSchema, describeIssues } from '../schema/index.js';
import { expandVariables, fail, homeDir, readJsonc } from '../util/index.js';
import { DEFAULTS } from './defaults.js';

/** Per-user folder for config and hooks. Survives reinstalling the npm package. */
export function userDir(): string {
  return process.env.AGENT_SANDBOX_HOME ?? path.join(homeDir(), '.agent-sandbox');
}
export function userConfigPath(): string {
  return path.join(userDir(), 'config.json');
}

/** Per-machine folder of an all-users install: %ProgramData%\AgentSandbox, or AGENT_SANDBOX_MACHINE_HOME (tests). */
export function machineRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_SANDBOX_MACHINE_HOME ?? path.join(env.ProgramData ?? 'C:\\ProgramData', 'AgentSandbox');
}
export function machineConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(machineRoot(env), 'config.json');
}

/**
 * The machine file, merged over the defaults and validated like a user file. Every user of the PC reads it, so the
 * folders in it must be full paths (after %VARIABLES% expand), never relative to someone's folder.
 */
function readMachineConfig(file: string): Config | null {
  if (!fs.existsSync(file)) return null;
  const raw = readJsonc<unknown>(file);
  const config = validateConfig(mergeConfig(DEFAULTS, raw), file);
  const folders: [string, string][] = config.mappings.map((m, i) => ['mappings[' + i + '].host', m.host]);
  if (_.has(raw, 'storage.root')) folders.push(['storage.root', config.storage.root]);
  const relative = folders.find(([, value]) => !path.isAbsolute(expandVariables(value)));
  if (relative)
    fail(
      file +
        ' is not valid:\n  - ' +
        relative[0] +
        ': "' +
        relative[1] +
        '" must be a full path (e.g. C:\\ProgramData\\...).',
      'Give the full path in the machine config.',
    );
  return config;
}

/** Deep merge where arrays (and anything that is not a plain object) replace instead of merging element by element. */
export function mergeConfig<T>(base: T, extra: unknown): T {
  return _.mergeWith(_.cloneDeep(base), extra, (_target: unknown, source: unknown) =>
    Array.isArray(source) ? source : undefined,
  );
}

/** Validates a full config; throws one readable error listing every problem. */
export function validateConfig(config: unknown, source: string): Config {
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) fail(source + ' is not valid:\n  - ' + describeIssues(parsed.error).join('\n  - '));
  return parsed.data;
}

/**
 * Layers, lowest first: built-in defaults, the machine file (%ProgramData%\AgentSandbox\config.json, when present), the
 * user file (--config, %AGENT_SANDBOX_CONFIG%, else ~/.agent-sandbox/config.json). Each file (JSON with comments) only
 * needs the keys it changes; the user file wins.
 */
export function loadConfig(explicitPath?: string): LoadedConfig {
  const requested = explicitPath ?? process.env.AGENT_SANDBOX_CONFIG;
  const full = path.resolve(requested ?? userConfigPath());
  const userFile = fs.existsSync(full) ? full : null;
  if (!userFile && requested)
    fail(
      'Config file not found: ' + full,
      'Check the --config path or AGENT_SANDBOX_CONFIG, or create one with: sandbox config init',
    );
  const machineFile = machineConfigPath();
  const machine = readMachineConfig(machineFile);
  const lowest = machine ?? structuredClone(DEFAULTS);
  const layers = { machine: machine ? machineFile : null, user: userFile };
  if (!userFile) return { config: lowest, configPath: null, base: userDir(), layers };
  return {
    config: validateConfig(mergeConfig(lowest, readJsonc<unknown>(userFile)), userFile),
    configPath: userFile,
    base: path.dirname(userFile),
    layers,
  };
}

export function assertNoGuestOverlap(mappings: { guest: string }[]): void {
  const normal = mappings.map((m) => m.guest.replace(/\\+$/, '').toLowerCase());
  normal.forEach((a, i) =>
    normal.slice(i + 1).forEach((b, j) => {
      if (a === b || a.startsWith(b + '\\') || b.startsWith(a + '\\'))
        fail(
          'Two folders map to overlapping places in the sandbox: ' +
            mappings[i].guest +
            ' and ' +
            mappings[i + 1 + j].guest +
            '.',
          'Give each mapping its own guest folder (one must not be inside the other).',
        );
    }),
  );
}
