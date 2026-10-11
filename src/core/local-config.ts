// A project's .sandbox-config.json: validated against the LocalOverrides schema (a safe subset of settings), applied
// over the user config, and only used once you have approved this exact version of the file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import _ from 'lodash';
import type { Config, LocalConfigFile, Overrides } from './types.js';
import { mergeConfig } from './config.js';
import { describeIssues, LocalOverrides } from './schema.js';
import { expandPath, fail, fileExists, parseJsonc, tryReadJson, writeJson } from './util.js';

export const LOCAL_CONFIG_NAME = '.sandbox-config.json';

/** Validates a folder's settings and resolves its relative paths against that folder. */
export const normalizeOverrides = (data: unknown, dir: string, source: string): Overrides => {
  const parsed = LocalOverrides.safeParse(data);
  if (!parsed.success) fail(source + ' is not valid:\n  - ' + describeIssues(parsed.error).join('\n  - '));
  const overrides = parsed.data;
  const scripts = overrides.scripts?.map((s) => expandPath(s, dir));
  const missing = scripts?.filter((s) => !fileExists(s)) ?? [];
  if (missing.length) fail(source + ' is not valid:\n  - scripts: file not found: ' + missing.join(', '));
  return { ...overrides, scripts, mappings: overrides.mappings?.map((m) => ({ ...m, host: expandPath(m.host, dir) })) };
};

/**
 * Protections a project file may only make stricter, never looser. A repo can ship the file, so it must not be able to
 * switch off what you turned on (or turn on what you turned off). The strictest of the two values always wins.
 */
const ON_IS_SAFER = ['readOnly', 'network.blockPrivateRanges', 'sandbox.protectedClient'];
const OFF_IS_SAFER = ['sandbox.networking', 'sandbox.clipboard', 'sandbox.audioInput', 'sandbox.videoInput', 'sandbox.printerRedirection', 'sandbox.vGpu', 'claudeProfile.copyCredentials'];
const GIT_STRICTNESS: Record<string, number> = { full: 0, readonly: 1, none: 2 };
export const NEVER_LOOSER = [...ON_IS_SAFER, ...OFF_IS_SAFER, 'provisioning.git.access'];

const keepStrictest = (yours: Config, merged: Config): void => {
  ON_IS_SAFER.forEach((p) => _.set(merged, p, Boolean(_.get(yours, p)) || Boolean(_.get(merged, p))));
  OFF_IS_SAFER.forEach((p) => _.set(merged, p, Boolean(_.get(yours, p)) && Boolean(_.get(merged, p))));
  if (GIT_STRICTNESS[yours.provisioning.git.access] > GIT_STRICTNESS[merged.provisioning.git.access]) merged.provisioning.git.access = yours.provisioning.git.access;
};

/** Applies validated overrides. Mappings with the same guest folder replace the configured ones. */
export const applyOverrides = (config: Config, ov: Overrides): Config => {
  const { harness, mappings, scripts: _scripts, $schema: _schema, ...rest } = ov;
  const next = mergeConfig(config, rest);
  keepStrictest(config, next);
  if (harness) next.defaultHarness = harness;
  if (mappings) next.mappings = [..._.reject(config.mappings, (m) => mappings.some((o) => o.guest.toLowerCase() === m.guest.toLowerCase())), ...mappings];
  return next;
};

const flatten = (value: unknown, prefix = ''): string[] =>
  _.isPlainObject(value) ? Object.entries(value as object).flatMap(([k, v]) => flatten(v, prefix ? prefix + '.' + k : k)) : [prefix + ' = ' + JSON.stringify(value)];

/** Human-readable list of what a local config changes, with risky items flagged. */
export const describeOverrides = (ov: Overrides): string[] => {
  const { harness, mappings = [], scripts = [], $schema: _schema, ...sections } = ov;
  const lines = [
    ...(harness ? ['agent = ' + harness] : []),
    ...mappings.map((m) => (m.readOnly ? 'read-only' : 'READ/WRITE') + ' folder ' + m.host + '  ->  ' + m.guest),
    ...scripts.map((s) => 'runs inside the sandbox: ' + s),
    ...flatten(sections),
  ];
  const risky = _.compact([
    mappings.some((m) => !m.readOnly) && 'a READ/WRITE mapping lets the agent change files outside your workspace',
  ]);
  // These are only used when they are stricter than your own settings, so a project can never loosen them.
  const limited = NEVER_LOOSER.filter((p) => _.has(sections, p)).map((p) => p + ' is only used if it is stricter than your own setting');
  return [...lines, ...risky.map((r) => '!! ' + r), ...limited.map((r) => '   ' + r)];
};

export const readLocalConfig = (dir: string): LocalConfigFile | null => {
  const file = path.join(dir, LOCAL_CONFIG_NAME);
  if (!fileExists(file)) return null;
  const raw = fs.readFileSync(file);
  return { path: file, hash: crypto.createHash('sha256').update(raw).digest('hex'), data: parseJsonc<unknown>(raw.toString('utf8'), file) };
};

// ---- approvals (host-only: <storage>\trusted-configs.json) ----------------------------------------------------------

export const trustStorePath = (storageRoot: string): string => path.join(storageRoot, 'trusted-configs.json');
const loadTrust = (store: string): Record<string, string> => tryReadJson<Record<string, string>>(store) ?? {};
const key = (file: string): string => path.resolve(file).toLowerCase();
export const isTrusted = (store: string, file: string, hash: string): boolean => loadTrust(store)[key(file)] === hash;
export const saveTrust = (store: string, file: string, hash: string): void => writeJson(store, { ...loadTrust(store), [key(file)]: hash });
