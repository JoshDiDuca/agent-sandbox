import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Config, Mapping, Overrides, ResolvedRun, RunRequest, ToolVersions, VersionSpec } from './types.js';
import { deriveGuest, guestConflict, guestFix, planMirrorWorkspace, tidyGuestPath } from '../shared/guest-paths.js';
import { autoGuestFolder, PROJECTS_GUEST, rootGuestDir, usableRoots } from '../shared/projects.js';
import { DATABASES, type Database } from './detect-databases.js';
import { allowedAnswer, allowRequests, allowStorePath, applyOverrides, describeOverrides, isTrusted, LOCAL_CONFIG_NAME, loosenedRequests, normalizeOverrides, OUTSIDE_FOLDER, outsideKey, outsideMappings, readLocalConfig, saveAllowed, saveTrust, trustStorePath } from './local-config.js';
import { assertSafeWorkspace } from './safe-paths.js';
import { dirExists, expandPath, fail, fileExists, isInsideOrEqual, plainText } from './util.js';

/** 'auto' guest workspace: C:\Workspace\<folder name> (shared/projects.ts, where every project's place is decided). */
export const autoGuestWorkspace = autoGuestFolder;

/**
 * A launch folder inside a project root appears under the root's folder (C:\Projects\<root>\<name>, or its PC path
 * with "mirror"), where it also is when another project started the sandbox, so git worktrees and Claude's project
 * folders keep working whichever project starts it. Only for "auto" / "mirror"; a filtered or read-only workspace
 * keeps its own mapping (the root would show the folder unfiltered and writable at that place).
 */
export const placeInRoot = (config: Config, workspaceHost: string, mirror: boolean, notes: string[]): Config => {
  const guest = rootGuestDir(usableRoots(config.projects.roots, dirExists), mirror, workspaceHost);
  if (!guest) return config;
  if (config.workspaceFilter.enabled || config.readOnly) {
    notes.push(workspaceHost + ' is inside a project root, but ' + (config.readOnly ? 'readOnly' : 'workspaceFilter') + ' is on, so it is mapped on its own at ' + config.guestWorkspace + ' (when another project starts the sandbox it is at ' + guest + ').');
    return config;
  }
  return { ...config, guestWorkspace: guest };
};

const firstLine = (file: string): string | null => {
  if (!fileExists(file)) return null;
  const line = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map((l: string) => l.replace(/#.*$/, '').trim()).find((l: string) => l !== '');
  return line ?? null;
};

const VOLTA_PIN = 'package.json volta.node';
const PackageJson = z.object({ volta: z.object({ node: z.string().regex(/^\d+(\.\d+){0,2}$/).optional() }).optional() });

/** The Node version a Volta project pins ("volta": { "node": "20.11.1" } in package.json), so nvm defaults to it too. */
export const voltaNode = (workspace: string): string | null => {
  const file = path.join(workspace, 'package.json');
  if (!fileExists(file)) return null;
  try { return PackageJson.safeParse(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))).data?.volta?.node ?? null; } catch { return null; }
};

/**
 * Picks tool versions. Highest priority first: command line, the folder's .sandbox-config.json,
 * version files in the workspace (.nvmrc, .node-version, .python-version), the tool config, this PC's node version.
 */
export const resolveVersions = (config: Config, workspace: string, local: Overrides, req: { nodeVersion?: string; pythonVersion?: string }, hostNodeVersion: string): ToolVersions => {
  const localTools = (local.toolchains ?? {}) as { node?: { version?: string }; python?: { version?: string } };
  const pick = (cli: string | undefined, localValue: string | undefined, files: string[], configured: string): VersionSpec => {
    if (cli) return { spec: cli, source: 'command line' };
    if (localValue) return { spec: localValue, source: '.sandbox-config.json' };
    for (const name of files) { const value = name === VOLTA_PIN ? voltaNode(workspace) : firstLine(path.join(workspace, name)); if (value) return { spec: value, source: name }; }
    return { spec: configured, source: 'config' };
  };
  let node = pick(req.nodeVersion, localTools.node?.version, ['.nvmrc', '.node-version', VOLTA_PIN], config.toolchains.node.version);
  if (node.spec === 'host') node = { spec: hostNodeVersion.replace(/^v/, ''), source: 'this PC' };
  const python = pick(req.pythonVersion, localTools.python?.version, ['.python-version'], config.toolchains.python.version);
  return { node, nodeExtra: config.toolchains.node.extraVersions, python };
};

/** Precedence (lowest to highest): built-in defaults, user config, .sandbox-config.json in the workspace, command-line flags. */
export const resolveRun = async (req: RunRequest, hostNodeVersion: string = process.version): Promise<ResolvedRun> => {
  const notes: string[] = [];
  // Mappings from the user config are relative to that config file; expand them before anything else uses them.
  const expand = (list: string[]): string[] => list.map((p) => expandPath(p, req.loaded.base));
  const projects = req.loaded.config.projects;
  let config = {
    ...req.loaded.config,
    mappings: req.loaded.config.mappings.map((m) => ({ ...m, host: expandPath(m.host, req.loaded.base) })),
    projects: { ...projects, roots: expand(projects.roots), exclude: expand(projects.exclude), declinedRoots: expand(projects.declinedRoots) },
  };
  const mirror = config.guestWorkspace === 'mirror';
  const storageRoot = expandPath(config.storage.root, req.loaded.base);

  const workspaceHost = path.resolve(req.workspace ?? req.cwd);
  if (!dirExists(workspaceHost)) fail('The workspace folder does not exist: ' + workspaceHost, 'Check the --workspace path, or cd into the project first.');
  assertSafeWorkspace(workspaceHost, req.packageRoot, storageRoot);

  const scripts: string[] = [];
  let localConfigPath: string | null = null;
  let overrides: Overrides = {};
  const local = req.noLocalConfig ? null : readLocalConfig(workspaceHost);
  let outsideAllowed: string[] = [];
  if (local) {
    overrides = normalizeOverrides(local.data, workspaceHost, local.path);
    const store = trustStorePath(storageRoot);
    if (!isTrusted(store, local.path, local.hash)) {
      const summary = describeOverrides(overrides, workspaceHost);
      let trusted = req.trustConfig;
      if (!trusted && req.ask) {
        console.log('\nFound ' + local.path + ' which is not trusted yet. It would apply:');
        for (const line of summary) console.log('  ' + plainText(line));
        trusted = await req.ask('Trust and use this file?');
      }
      if (!trusted) fail(local.path + ' has not been approved yet (a repo can ship this file, so it needs your OK). It would apply:\n  ' + (summary.map(plainText).join('\n  ') || '(no changes)'), 'Review it, then run again in an interactive terminal and answer y, or add --trust-config. To ignore the file: --no-local-config');
      saveTrust(store, local.path, local.hash);
      notes.push('Trusted ' + local.path + ' (you will only be asked again if the file changes).');
    }
    // A project may only tighten. What it asks for beyond that (a looser setting, a folder outside the project) is used
    // only if you allowed it for this project: asked once, in one question, at an interactive launch, never by
    // --trust-config. Folders outside the project follow projects.allowOutsideMappings (your settings only). A looser
    // setting you did not allow is named in the notes instead of dropped silently.
    const allowStore = allowStorePath(storageRoot);
    const policy = config.projects.allowOutsideMappings;
    // An optional folder that is not on this PC is skipped at launch, so it needs no answer (yet).
    const outside = outsideMappings(workspaceHost, overrides.mappings).filter((m) => !m.optional || dirExists(m.host));
    const name = path.basename(workspaceHost) + '\'s ' + LOCAL_CONFIG_NAME;
    const preview = guestWorkspaceOf(applyOverrides(config, overrides), workspaceHost).guest;
    const describe = (m: Mapping): string => (m.readOnly ? 'read-only  ' : 'READ/WRITE ') + m.host + '  ->  ' + previewGuest(m, workspaceHost, preview).guest;
    if (outside.length && policy === false) {
      fail(name + ' maps ' + outside.length + ' folder' + (outside.length === 1 ? '' : 's') + ' outside the project, and your settings do not allow that:\n  ' + outside.map(describe).join('\n  '),
        'Allow it: set projects.allowOutsideMappings to "ask" or true in your settings (sandbox > Settings, or the file sandbox config path shows). Or remove those mappings from the file.');
    }
    const looser = loosenedRequests(config, overrides);
    const interactive = Boolean(req.ask) && (req.interactive ?? Boolean(process.stdin.isTTY));
    const openOutside = policy === 'ask' ? outside.filter((m) => allowedAnswer(allowStore, local.path, OUTSIDE_FOLDER, outsideKey(m)) !== true) : [];
    const openLooser = looser.filter((a) => allowedAnswer(allowStore, local.path, a.key, a.wanted) === null);
    let declinedOutside = false;
    if (interactive && req.ask && (openOutside.length || openLooser.length)) {
      console.log('\n' + name + ' asks for more than your settings allow:');
      if (openOutside.length) console.log('  Folders outside the project:\n' + openOutside.map((m) => '    ' + plainText(describe(m))).join('\n'));
      for (const a of openLooser) console.log('  ' + a.key + ' = ' + JSON.stringify(a.wanted) + '  (your settings: ' + JSON.stringify(a.yours) + ')');
      const ok = await req.ask('Allow ' + (openOutside.length + openLooser.length === 1 ? 'it' : 'these') + ' for this project?');
      for (const a of openLooser) saveAllowed(allowStore, local.path, a.key, a.wanted, ok);
      // A "no" to folders is not kept: the next interactive launch asks again.
      if (ok) for (const m of openOutside) saveAllowed(allowStore, local.path, OUTSIDE_FOLDER, outsideKey(m), true);
      declinedOutside = !ok && openOutside.length > 0;
    }
    const notAllowed = policy === 'ask' ? outside.filter((m) => allowedAnswer(allowStore, local.path, OUTSIDE_FOLDER, outsideKey(m)) !== true) : [];
    if (notAllowed.length) {
      const what = name + ' maps ' + notAllowed.length + ' folder' + (notAllowed.length === 1 ? '' : 's') + ' outside the project:\n  ' + notAllowed.map(describe).join('\n  ');
      fail(what + (declinedOutside ? '\nYou did not allow ' + (notAllowed.length === 1 ? 'it' : 'them') + ', so the sandbox was not started.' : '\nThat needs your OK once (a repo ships this file), and this launch cannot ask (no interactive terminal).'),
        'Allow ' + (notAllowed.length === 1 ? 'it' : 'them') + ': start it from an interactive terminal and answer y, or set projects.allowOutsideMappings to true in your settings (sandbox > Settings, or the file sandbox config path shows).');
    }
    outsideAllowed = [...new Set(outside.map((m) => m.host))];
    if (outside.length) notes.push('Folders outside the project allowed for ' + name + ' (' + (policy === true ? 'projects.allowOutsideMappings is true' : 'your answer is kept in ' + allowStore) + '): ' + outsideAllowed.join(', '));
    const allowed: { key: string; wanted: unknown }[] = [];
    for (const ask of looser) {
      const ok = allowedAnswer(allowStore, local.path, ask.key, ask.wanted);
      if (ok) { allowed.push(ask); notes.push('Allowed for this project: ' + ask.key + ' = ' + JSON.stringify(ask.wanted) + ' (your answer is kept in ' + allowStore + ').'); }
      else notes.push('The project asks for ' + ask.key + ' = ' + JSON.stringify(ask.wanted) + ', but your settings say ' + JSON.stringify(ask.yours) + ', so it is not used. ' + (ok === false ? 'You said no (kept in ' + allowStore + ').' : 'Start it from an interactive terminal to allow it for this project.') + ' Or set ' + ask.key + ' in your own settings (sandbox, then Settings > All projects).');
    }
    config = applyOverrides(allowRequests(config, allowed), overrides);
    scripts.push(...(overrides.scripts ?? []));
    localConfigPath = local.path;
    notes.push('Using ' + local.path);
  }
  if (req.headless !== undefined) config = { ...config, sandbox: { ...config.sandbox, headless: req.headless } };
  for (const name of req.databases ?? []) {
    const db = name.toLowerCase() as Database;
    if (!DATABASES.includes(db)) fail('Unknown database "' + name + '".', 'Choose from: ' + DATABASES.join(', '));
    config = { ...config, databases: { ...config.databases, [db]: { ...config.databases[db], enabled: true } } };
  }
  // auto / mirror: a project inside a root is where the root shows it, whichever project starts the sandbox.
  const guest = guestWorkspaceOf(config, workspaceHost);
  const placed = config.guestWorkspace === 'auto' || mirror ? placeInRoot({ ...config, guestWorkspace: guest.guest }, workspaceHost, mirror, notes) : { ...config, guestWorkspace: guest.guest };
  if (guest.note && placed.guestWorkspace === guest.guest) notes.push(guest.note);
  config = placed;

  scripts.push(...req.scripts.map((s: string) => path.resolve(s)));
  const harnessName = req.noAgent ? 'none' : (req.harness ?? config.defaultHarness);
  if (harnessName !== 'none' && !config.harnesses[harnessName]) fail('Unknown agent "' + harnessName + '".', 'Configured agents: ' + Object.keys(config.harnesses).join(', ') + ' (add more under "harnesses" in your config).');
  const versions = resolveVersions(config, workspaceHost, overrides, req, hostNodeVersion);
  const dataPath = path.join(storageRoot, 'data', config.storage.dataName);
  // A project file may ask for "mirror" too (it decides only its own path); project roots follow the user's choice.
  return { config, storageRoot, dataPath, workspaceHost, harnessName, scripts, localConfigPath, notes, versions, mirror, outsideMappings: outsideAllowed };
};

/** Where the workspace appears: guestWorkspace "auto", "mirror" (with a note when it falls back) or a path. */
export const guestWorkspaceOf = (config: Pick<Config, 'guestWorkspace'>, workspaceHost: string): { guest: string; note: string | null } => {
  if (config.guestWorkspace === 'auto') return { guest: autoGuestWorkspace(workspaceHost), note: null };
  if (config.guestWorkspace === 'mirror') return planMirrorWorkspace(workspaceHost, autoGuestWorkspace(workspaceHost));
  return { guest: config.guestWorkspace, note: null };
};

/**
 * Where a mapping will most likely appear, before the launch knows every other folder (the prompt and config check
 * show it; the launch places it for real in host/launch/mappings.ts with the same rules).
 */
export const previewGuest = (m: Pick<Mapping, 'host' | 'guest'>, workspaceHost: string, workspaceGuest: string): { guest: string; note: string | null } => {
  const guest = tidyGuestPath(m.guest ?? deriveGuest(m.host, workspaceHost, workspaceGuest));
  const conflict = guestConflict(guest, [
    ...(m.guest || !isInsideOrEqual(workspaceHost, m.host) ? [{ guest: workspaceGuest, what: 'the project' }] : []),
    { guest: PROJECTS_GUEST, what: 'other projects' },
  ]);
  return { guest, note: conflict ? m.host + ': ' + conflict + '. Fix: ' + guestFix(m.guest) : null };
};
