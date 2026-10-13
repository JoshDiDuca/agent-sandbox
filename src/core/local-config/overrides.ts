import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import type { Config, Overrides } from '../types.js';
import { mergeConfig } from '../config/index.js';
import { describeIssues, LocalOverridesSchema } from '../schema/index.js';
import { expandPath, fail, fileExists, isInsideOrEqual } from '../util/index.js';

/** Validates a folder's settings and resolves its relative paths against that folder. */
export const normalizeOverrides = (data: unknown, dir: string, source: string): Overrides => {
  const parsed = LocalOverridesSchema.safeParse(data);
  if (!parsed.success) fail(source + ' is not valid:\n  - ' + describeIssues(parsed.error).join('\n  - '));
  const overrides = parsed.data;
  const scripts = overrides.scripts?.map((s) => expandPath(s, dir));
  const missing = scripts?.filter((s) => !fileExists(s)) ?? [];
  if (missing.length) fail(source + ' is not valid:\n  - scripts: file not found: ' + missing.join(', '));
  const mappings = overrides.mappings?.map((m) => ({ ...m, host: expandPath(m.host, dir) }));
  // A repo ships this file, so it must not reach the rest of this PC: its extra folders stay inside the project.
  const outside = mappings?.filter((m) => !insideProject(dir, m.host)) ?? [];
  if (outside.length)
    fail(
      source +
        ' is not valid:\n  - mappings: a project file may only map folders inside the project, not ' +
        outside.map((m) => m.host).join(', '),
      'Map other folders in your own settings (sandbox config path shows where they are).',
    );
  return { ...overrides, scripts, mappings };
};

/** `folder` (also where it really is, through links) is inside the project folder `dir`. */
const insideProject = (dir: string, folder: string): boolean => {
  // Where a path really is: the nearest existing folder resolved (links, 8.3 short names), plus the part not created yet.
  const real = (p: string): string => {
    const full = path.resolve(p);
    try {
      return fs.realpathSync.native(full);
    } catch {
      return path.dirname(full) === full ? full : path.join(real(path.dirname(full)), path.basename(full));
    }
  };
  return isInsideOrEqual(dir, folder) && isInsideOrEqual(real(dir), real(folder));
};

/**
 * Protections a project file may only make stricter, never looser. A repo can ship the file, so it must not be able to
 * switch off what you turned on (or turn on what you turned off). The strictest of the two values always wins.
 */
export const ON_IS_SAFER = [
  'readOnly',
  'workspaceFilter.enabled',
  'network.blockPrivateRanges',
  'sandbox.protectedClient',
  'downloads.requireChecksum',
];
export const OFF_IS_SAFER = [
  'sandbox.networking',
  'sandbox.clipboard',
  'sandbox.audioInput',
  'sandbox.videoInput',
  'sandbox.printerRedirection',
  'sandbox.vGpu',
  'claudeProfile.copyCredentials',
  'claudeProfile.enabled',
  'claudeProfile.syncHistory',
  'claudeProfile.syncClaudeMem',
];
export const GIT_STRICTNESS: Record<string, number> = { full: 0, readonly: 1, none: 2 };
export const NEVER_LOOSER = [...ON_IS_SAFER, ...OFF_IS_SAFER, 'provisioning.git.access'];

const keepStrictest = (yours: Config, merged: Config): void => {
  ON_IS_SAFER.forEach((p) => _.set(merged, p, Boolean(_.get(yours, p)) || Boolean(_.get(merged, p))));
  OFF_IS_SAFER.forEach((p) => _.set(merged, p, Boolean(_.get(yours, p)) && Boolean(_.get(merged, p))));
  if (GIT_STRICTNESS[yours.provisioning.git.access] > GIT_STRICTNESS[merged.provisioning.git.access])
    merged.provisioning.git.access = yours.provisioning.git.access;
};

/** What a project file asks for that would loosen one of your protections (so it is not used). */
export const loosenedRequests = (config: Config, ov: Overrides): { key: string; wanted: unknown; yours: unknown }[] =>
  [
    ...ON_IS_SAFER.filter((p) => _.has(ov, p) && !_.get(ov, p) && _.get(config, p)),
    ...OFF_IS_SAFER.filter((p) => _.has(ov, p) && _.get(ov, p) && !_.get(config, p)),
    ...(_.has(ov, 'provisioning.git.access') &&
    GIT_STRICTNESS[_.get(ov, 'provisioning.git.access') as string] < GIT_STRICTNESS[config.provisioning.git.access]
      ? ['provisioning.git.access']
      : []),
  ].map((key) => ({ key, wanted: _.get(ov, key), yours: _.get(config, key) }));

/** Applies validated overrides. Mappings with the same guest folder replace the configured ones. */
export const applyOverrides = (config: Config, ov: Overrides): Config => {
  const { harness, mappings, scripts: _scripts, $schema: _schema, ...rest } = ov;
  const next = mergeConfig(config, rest);
  keepStrictest(config, next);
  if (harness) next.defaultHarness = harness;
  // A project adds catalogue apps to yours; it never removes the ones you chose.
  if (rest.apps?.install) next.apps.install = _.union(config.apps.install, rest.apps.install);
  // Its patterns keep more out on top of yours; yours stay.
  if (rest.network?.blockHosts) next.network.blockHosts = _.union(config.network.blockHosts, rest.network.blockHosts);
  if (rest.workspaceFilter?.exclude)
    next.workspaceFilter.exclude = _.union(config.workspaceFilter.exclude, rest.workspaceFilter.exclude);
  if (mappings)
    next.mappings = [
      ..._.reject(config.mappings, (m) => mappings.some((o) => o.guest.toLowerCase() === m.guest.toLowerCase())),
      ...mappings,
    ];
  return next;
};

const flatten = (value: unknown, prefix = ''): string[] =>
  _.isPlainObject(value)
    ? Object.entries(value as object).flatMap(([k, v]) => flatten(v, prefix ? prefix + '.' + k : k))
    : [prefix + ' = ' + JSON.stringify(value)];

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
  const limited = NEVER_LOOSER.filter((p) => _.has(sections, p)).map(
    (p) => p + ' is only used if it is stricter than your own setting',
  );
  return [...lines, ...risky.map((r) => '!! ' + r), ...limited.map((r) => '   ' + r)];
};

/** Your config with these requests let through, so applyOverrides' "strictest wins" keeps the project's value. */
export const allowRequests = (config: Config, allowed: { key: string; wanted: unknown }[]): Config => {
  const next = _.cloneDeep(config);
  allowed.forEach((a) => _.set(next, a.key, a.wanted));
  return next;
};
