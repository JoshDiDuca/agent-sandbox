import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Config, Overrides, ResolvedRun, RunRequest, ToolVersions, VersionSpec } from './types.js';
import { applyOverrides, describeOverrides, isTrusted, normalizeOverrides, readLocalConfig, saveTrust, trustStorePath } from './local-config.js';
import { dirExists, expandPath, fail, fileExists, isInsideOrEqual, isRootPath, isUserProfile } from './util.js';

export const askYesNo = async (question: string): Promise<boolean> => {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question + ' [y/N] ', resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
};

/** The agent gets read/write access to the workspace, so refuse folders that would let it reach the tool itself, its storage, or the OS. */
export const assertSafeWorkspace = (workspace: string, packageRoot: string, storageRoot: string): void => {
  if (isRootPath(workspace)) fail('Refusing to use a drive root as the workspace: ' + workspace);
  if (isUserProfile(workspace)) fail('Refusing to use your whole user profile as the workspace: ' + workspace + '. Run from a project folder instead.');
  const protectedDirs: [string, string][] = [['the agent-sandbox install folder', packageRoot], ['the sandbox storage folder', storageRoot]];
  for (const [label, dir] of protectedDirs) {
    if (isInsideOrEqual(dir, workspace)) fail('Refusing to use ' + workspace + ' as the workspace: it is inside ' + label + ' (' + dir + ').');
    if (isInsideOrEqual(workspace, dir)) fail('Refusing to use ' + workspace + ' as the workspace: it contains ' + label + ' (' + dir + '), so the agent could modify it.');
  }
  for (const name of ['WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const dir = process.env[name];
    if (dir && isInsideOrEqual(dir, workspace)) fail('Refusing to use a system folder as the workspace: ' + workspace);
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

/**
 * Picks tool versions. Highest priority first: command line, the folder's .sandbox-config.json,
 * version files in the workspace (.nvmrc, .node-version, .python-version), the tool config, this PC's node version.
 */
export const resolveVersions = (config: Config, workspace: string, local: Overrides, req: { nodeVersion?: string; pythonVersion?: string }, hostNodeVersion: string): ToolVersions => {
  const localTools = (local.toolchains ?? {}) as { node?: { version?: string }; python?: { version?: string } };
  const pick = (cli: string | undefined, localValue: string | undefined, files: string[], configured: string): VersionSpec => {
    if (cli) return { spec: cli, source: 'command line' };
    if (localValue) return { spec: localValue, source: '.sandbox-config.json' };
    for (const name of files) { const value = firstLine(path.join(workspace, name)); if (value) return { spec: value, source: name }; }
    return { spec: configured, source: 'config' };
  };
  let node = pick(req.nodeVersion, localTools.node?.version, ['.nvmrc', '.node-version'], config.toolchains.node.version);
  if (node.spec === 'host') node = { spec: hostNodeVersion.replace(/^v/, ''), source: 'this PC' };
  const python = pick(req.pythonVersion, localTools.python?.version, ['.python-version'], config.toolchains.python.version);
  return { node, nodeExtra: config.toolchains.node.extraVersions, python };
};

/** Precedence (lowest to highest): built-in defaults, user config, .sandbox-config.json in the workspace, command-line flags. */
export const resolveRun = async (req: RunRequest, hostNodeVersion: string = process.version): Promise<ResolvedRun> => {
  const notes: string[] = [];
  let config = req.loaded.config;
  const storageRoot = expandPath(config.storage.root, req.loaded.base);

  const workspaceHost = path.resolve(req.workspace ?? req.cwd);
  if (!dirExists(workspaceHost)) fail('Workspace folder does not exist: ' + workspaceHost);
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
      if (!trusted) fail('Untrusted ' + local.path + ' (a repo can ship this file, so it needs your approval). It would apply:\n  ' + (summary.join('\n  ') || '(no changes)') + '\nReview it, then re-run with --trust-config (or answer y when asked). Use --no-local-config to ignore it.');
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

  scripts.push(...req.scripts.map((s: string) => path.resolve(s)));
  const harnessName = req.noAgent ? 'none' : (req.harness ?? config.defaultHarness);
  if (harnessName !== 'none' && !config.harnesses[harnessName]) fail('Unknown agent "' + harnessName + '". Configured agents: ' + Object.keys(config.harnesses).join(', '));
  const versions = resolveVersions(config, workspaceHost, overrides, req, hostNodeVersion);
  const dataPath = path.join(storageRoot, 'data', config.storage.dataName);
  return { config, storageRoot, dataPath, workspaceHost, harnessName, scripts, localConfigPath, notes, versions };
};
