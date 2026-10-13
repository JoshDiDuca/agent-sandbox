import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import type { Config, LoadedConfig } from '../types.js';
import { ConfigSchema, describeIssues } from '../schema/index.js';
import { fail, homeDir, readJsonc } from '../util/index.js';
import { DEFAULTS } from './defaults.js';

/** Per-user folder for config and hooks. Survives reinstalling the npm package. */
export const userDir = (): string => process.env.AGENT_SANDBOX_HOME ?? path.join(homeDir(), '.agent-sandbox');
export const userConfigPath = (): string => path.join(userDir(), 'config.json');

/** Deep merge where arrays (and anything that is not a plain object) replace instead of merging element by element. */
export const mergeConfig = <T>(base: T, extra: unknown): T =>
  _.mergeWith(_.cloneDeep(base), extra, (_target: unknown, source: unknown) =>
    Array.isArray(source) ? source : undefined,
  );

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
    if (requested)
      fail(
        'Config file not found: ' + full,
        'Check the --config path or AGENT_SANDBOX_CONFIG, or create one with: sandbox config init',
      );
    return { config: structuredClone(DEFAULTS), configPath: null, base: userDir() };
  }
  return {
    config: validateConfig(mergeConfig(DEFAULTS, readJsonc<unknown>(full)), full),
    configPath: full,
    base: path.dirname(full),
  };
};

export const assertNoGuestOverlap = (mappings: { guest: string }[]): void => {
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
};
