import path from 'node:path';
import readline from 'node:readline';
//TS import type { Overrides, ResolvedRun, RunRequest } from './types.js';
import { applyOverrides, describeOverrides, isTrusted, normalizeOverrides, readLocalConfig, saveTrust, trustStorePath } from './localconfig.js';
import { dirExists, ensureDir, expandPath, fail, isRootPath, isUserProfile } from './util.js';

export async function askYesNo(question/*: string*/)/*: Promise<boolean>*/ {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise/*<string>*/((resolve/*: (value: string) => void*/) => rl.question(question + ' [y/N] ', resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function isInsideOrEqual(parent/*: string*/, child/*: string*/)/*: boolean*/ {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The agent gets read/write access to the workspace, so refuse folders that would let it reach the tool itself, its storage, or the OS. */
export function assertSafeWorkspace(workspace/*: string*/, projectRoot/*: string*/, storageRoot/*: string*/)/*: void*/ {
  if (isRootPath(workspace)) fail('Refusing to use a drive root as the workspace: ' + workspace);
  if (isUserProfile(workspace)) fail('Refusing to use your whole user profile as the workspace: ' + workspace + '. Run from a project folder instead.');
  const protectedDirs/*: [string, string][]*/ = [['the agent-sandbox install folder', projectRoot], ['the sandbox storage folder', storageRoot]];
  for (const [label, dir] of protectedDirs) {
    if (isInsideOrEqual(dir, workspace)) fail('Refusing to use ' + workspace + ' as the workspace: it is inside ' + label + ' (' + dir + ').');
    if (isInsideOrEqual(workspace, dir)) fail('Refusing to use ' + workspace + ' as the workspace: it contains ' + label + ' (' + dir + '), so the agent could modify it.');
  }
  for (const name of ['WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const dir = process.env[name];
    if (dir && isInsideOrEqual(dir, workspace)) fail('Refusing to use a system folder as the workspace: ' + workspace);
  }
}

/** Order of precedence (lowest to highest): built-in defaults, config.json, --project preset, .sandbox-config.json in the workspace, command-line flags. */
export async function resolveRun(req/*: RunRequest*/)/*: Promise<ResolvedRun>*/ {
  const { loaded } = req;
  const notes/*: string[]*/ = [];
  let config = loaded.config;
  let preset/*: Overrides*/ = {};
  if (req.project) {
    const raw = config.projects?.[req.project];
    if (!raw) fail('Unknown project preset "' + req.project + '". Presets in config.json: ' + (Object.keys(config.projects ?? {}).join(', ') || '(none)'));
    preset = normalizeOverrides(raw, loaded.base, true, 'config.json projects.' + req.project);
    notes.push('Project preset: ' + req.project);
  }
  const storageRoot = expandPath(config.storage.root, loaded.base);

  let workspaceHost = path.resolve(req.cwd);
  if (req.workspace) workspaceHost = path.resolve(req.workspace);
  else if (preset.workspace) {
    workspaceHost = preset.workspace;
    if (!dirExists(workspaceHost) && preset.createWorkspace) ensureDir(workspaceHost);
  }
  if (!dirExists(workspaceHost)) fail('Workspace folder does not exist: ' + workspaceHost);
  assertSafeWorkspace(workspaceHost, req.projectRoot, storageRoot);

  config = applyOverrides(config, preset);
  const scripts/*: string[]*/ = [...(preset.scripts ?? [])];
  let localConfigPath/*: string | null*/ = null;

  if (!req.noLocalConfig) {
    const local = readLocalConfig(workspaceHost);
    if (local) {
      const overrides = normalizeOverrides(local.data, workspaceHost, false, local.path);
      const store = trustStorePath(storageRoot);
      let trusted = isTrusted(store, local.path, local.hash);
      if (!trusted) {
        const summary = describeOverrides(overrides);
        if (req.trustConfig) trusted = true;
        else if (req.ask) {
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
  }

  scripts.push(...req.scripts);
  const harnessName = req.noAgent ? 'none' : (req.harness ?? config.defaultHarness);
  if (harnessName !== 'none' && !config.harnesses[harnessName]) fail('Unknown agent "' + harnessName + '". Configured agents: ' + Object.keys(config.harnesses).join(', '));
  const dataName = req.project ?? config.storage.dataName;
  if (!/^[A-Za-z0-9_-]+$/.test(dataName)) fail('Invalid storage data name: ' + dataName);
  return { config, workspaceHost, dataName, harnessName, scripts, localConfigPath, notes };
}
