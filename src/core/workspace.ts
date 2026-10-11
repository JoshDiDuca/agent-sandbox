import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { z } from 'zod';
import type { Config, Overrides, ResolvedRun, RunRequest, ToolVersions, VersionSpec } from './types.js';
import { userDir } from './config.js';
import { planMirrorWorkspace } from '../shared/guest-paths.js';
import { applyOverrides, describeOverrides, isTrusted, normalizeOverrides, readLocalConfig, saveTrust, trustStorePath } from './local-config.js';
import { dirExists, expandPath, fail, fileExists, isInsideOrEqual, isRootPath, isUserProfile } from './util.js';

export const askYesNo = async (question: string): Promise<boolean> => {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question + ' [y/N] ', resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
};

/** Folders the agent must never be able to write: the tool itself, its storage and your settings for it. */
const protectedFolders = (packageRoot: string, storageRoot: string): [string, string][] => [
  ['this tool\'s install folder', packageRoot],
  ['the sandbox storage folder', storageRoot],
  ['your sandbox settings folder', userDir()],
];

/** A read/write folder mapped into the sandbox must not contain, or sit inside, any protected folder. */
export const assertSafeMapping = (folder: string, packageRoot: string, storageRoot: string): void => {
  if (isRootPath(folder) || isUserProfile(folder)) fail('A whole drive or user profile cannot be mapped into the sandbox: ' + folder, 'Map a specific folder instead.');
  for (const [label, dir] of protectedFolders(packageRoot, storageRoot)) {
    if (isInsideOrEqual(dir, folder) || isInsideOrEqual(folder, dir)) fail(folder + ' cannot be mapped into the sandbox: it overlaps ' + label + ' (' + dir + ').', 'Map a folder that is not inside (and does not contain) ' + dir + '.');
  }
};

/** The agent gets read/write access to the workspace, so refuse folders that would let it reach the tool itself, its storage, or the OS. */
export const assertSafeWorkspace = (workspace: string, packageRoot: string, storageRoot: string): void => {
  if (isRootPath(workspace)) fail('A whole drive cannot be the workspace: ' + workspace, 'Run sandbox claude from a project folder (or pass --workspace <folder>).');
  if (isUserProfile(workspace)) fail('Your whole user profile cannot be the workspace: ' + workspace, 'Run sandbox claude from a project folder (or pass --workspace <folder>).');
  for (const [label, dir] of protectedFolders(packageRoot, storageRoot)) {
    if (isInsideOrEqual(dir, workspace)) fail(workspace + ' cannot be the workspace: it is inside ' + label + ' (' + dir + '), so the agent could change the code that runs on this PC.', dir === packageRoot ? 'Developing windows-development-sandbox itself? Install it as a copy instead of a link: run `npm run install:global` in the repository, then sandbox claude works there.' : 'Run sandbox claude from a project folder somewhere else.');
    if (isInsideOrEqual(workspace, dir)) fail(workspace + ' cannot be the workspace: it contains ' + label + ' (' + dir + '), which the agent must not be able to change.', 'Run sandbox claude from a project folder that does not contain it.');
  }
  for (const name of ['WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const dir = process.env[name];
    if (dir && isInsideOrEqual(dir, workspace)) fail('A system folder cannot be the workspace: ' + workspace, 'Run sandbox claude from a project folder.');
  }
};

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
  let config = { ...req.loaded.config, mappings: req.loaded.config.mappings.map((m) => ({ ...m, host: expandPath(m.host, req.loaded.base) })) };
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
        for (const line of summary) console.log('  ' + line);
        trusted = await req.ask('Trust and use this file?');
      }
      if (!trusted) fail(local.path + ' has not been approved yet (a repo can ship this file, so it needs your OK). It would apply:\n  ' + (summary.join('\n  ') || '(no changes)'), 'Review it, then run again in an interactive terminal and answer y, or add --trust-config. To ignore the file: --no-local-config');
      saveTrust(store, local.path, local.hash);
      notes.push('Trusted ' + local.path + ' (you will only be asked again if the file changes).');
    }
    config = applyOverrides(config, overrides);
    scripts.push(...(overrides.scripts ?? []));
    localConfigPath = local.path;
    notes.push('Using ' + local.path);
  }
  if (req.headless !== undefined) config = { ...config, sandbox: { ...config.sandbox, headless: req.headless } };
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
  return { config, storageRoot, dataPath, workspaceHost, harnessName, scripts, localConfigPath, notes, versions };
};
