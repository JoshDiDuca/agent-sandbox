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

/** Applies validated overrides. Mappings with the same guest folder replace the configured ones. */
export const applyOverrides = (config: Config, ov: Overrides): Config => {
  const { harness, mappings, scripts: _scripts, ...rest } = ov;
  const next = mergeConfig(config, rest);
  if (harness) next.defaultHarness = harness;
  if (mappings) next.mappings = [..._.reject(config.mappings, (m) => mappings.some((o) => o.guest.toLowerCase() === m.guest.toLowerCase())), ...mappings];
  return next;
};

const flatten = (value: unknown, prefix = ''): string[] =>
  _.isPlainObject(value) ? Object.entries(value as object).flatMap(([k, v]) => flatten(v, prefix ? prefix + '.' + k : k)) : [prefix + ' = ' + JSON.stringify(value)];

/** Human-readable list of what a local config changes, with risky items flagged. */
export const describeOverrides = (ov: Overrides): string[] => {
  const { harness, mappings = [], scripts = [], ...sections } = ov;
  const lines = [
    ...(harness ? ['agent = ' + harness] : []),
    ...mappings.map((m) => (m.readOnly ? 'read-only' : 'READ/WRITE') + ' folder ' + m.host + '  ->  ' + m.guest),
    ...scripts.map((s) => 'runs inside the sandbox: ' + s),
    ...flatten(sections),
  ];
  const risky = _.compact([
    ov.claudeProfile?.copyCredentials === true && 'claudeProfile.copyCredentials = true copies your Claude LOGIN into the sandbox',
    ov.network?.blockPrivateRanges === false && 'network.blockPrivateRanges = false turns OFF the LAN block',
    mappings.some((m) => !m.readOnly) && 'a READ/WRITE mapping lets the agent change files outside your workspace',
    ov.provisioning?.git?.access === 'full' && 'provisioning.git.access = full lets the agent commit and push',
    ov.sandbox?.vGpu === true && 'sandbox.vGpu = true widens the sandbox attack surface',
  ]);
  return [...lines, ...risky.map((r) => '!! ' + r)];
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
