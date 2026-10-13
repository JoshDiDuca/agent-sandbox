import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Config, Overrides, ResolvedRun, RunRequest, ToolVersions, VersionSpec } from './types.js';
import { planMirrorWorkspace } from '../shared/guest-paths.js';
import { DATABASES, type Database } from './detect-databases.js';
import { allowedAnswer, allowRequests, allowStorePath, applyOverrides, describeOverrides, isTrusted, loosenedRequests, saveAllowed, normalizeOverrides, readLocalConfig, saveTrust, trustStorePath } from './local-config.js';
import { assertSafeWorkspace } from './safe-paths.js';
import { dirExists, expandPath, fail, fileExists, plainText } from './util.js';

/**
 * 'auto' guest workspace: C:\Workspace\<folder name>. Keeping the real folder name means Claude's per-project history
 * and claude-mem's project name match this PC instead of every project being "Workspace".
 */
export const autoGuestWorkspace = (workspaceHost: string): string => {
  const name = path.basename(workspaceHost).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  return 'C:\\Workspace\\' + (name || 'project');
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
  if (local) {
    overrides = normalizeOverrides(local.data, workspaceHost, local.path);
    const store = trustStorePath(storageRoot);
    if (!isTrusted(store, local.path, local.hash)) {
      const summary = describeOverrides(overrides);
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
    // A project may only tighten. What it asks for beyond that is used only if you allowed it for this project (asked
    // once, interactively, never by --trust-config); otherwise it is named here instead of dropped silently.
    const allowStore = allowStorePath(storageRoot);
    const allowed: { key: string; wanted: unknown }[] = [];
    for (const ask of loosenedRequests(config, overrides)) {
      let ok = allowedAnswer(allowStore, local.path, ask.key, ask.wanted);
      if (ok === null && req.ask && process.stdin.isTTY) {
        ok = await req.ask('This project asks for ' + ask.key + ' = ' + JSON.stringify(ask.wanted) + ', which is looser than your settings (' + JSON.stringify(ask.yours) + '). Allow it for this project only?');
        saveAllowed(allowStore, local.path, ask.key, ask.wanted, ok);
      }
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
  if (config.guestWorkspace === 'auto') config = { ...config, guestWorkspace: autoGuestWorkspace(workspaceHost) };
  else if (config.guestWorkspace === 'mirror') {
    const plan = planMirrorWorkspace(workspaceHost, autoGuestWorkspace(workspaceHost));
    if (plan.note) notes.push(plan.note);
    config = { ...config, guestWorkspace: plan.guest };
  }

  scripts.push(...req.scripts.map((s: string) => path.resolve(s)));
  const harnessName = req.noAgent ? 'none' : (req.harness ?? config.defaultHarness);
  if (harnessName !== 'none' && !config.harnesses[harnessName]) fail('Unknown agent "' + harnessName + '".', 'Configured agents: ' + Object.keys(config.harnesses).join(', ') + ' (add more under "harnesses" in your config).');
  const versions = resolveVersions(config, workspaceHost, overrides, req, hostNodeVersion);
  const dataPath = path.join(storageRoot, 'data', config.storage.dataName);
  // A project file may ask for "mirror" too (it decides only its own path); project roots follow the user's choice.
  return { config, storageRoot, dataPath, workspaceHost, harnessName, scripts, localConfigPath, notes, versions, mirror };
};
