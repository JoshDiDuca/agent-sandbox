import path from 'node:path';
import fs from 'node:fs';
//TS import type { Config, LoadedConfig } from './types.js';
import { assertGuestPath, expandPath, fail, isRootPath, readJson } from './util.js';

const DEFAULTS = {
  version: 2,
  sandbox: { memoryMb: 'auto', maxMemoryMb: 32768, reserveHostMb: 8192, vGpu: true, networking: true, clipboard: true, audioInput: false, videoInput: false, printerRedirection: false, protectedClient: true },
  storage: { persistAgentState: true },
  network: { blockPrivateRanges: true, publicDns: ['1.1.1.1', '8.8.8.8'] },
  provisioning: { copyFromHost: true, fallbackToInstall: true, refresh: false, node: { version: 'lts', hostDir: 'auto' }, git: { enabled: true }, terminal: { enabled: false, launchAgentInTerminal: false } },
  hooks: { failFast: false },
  claudeProfile: { enabled: true, hostDir: 'auto', include: ['settings.json', 'CLAUDE.md', 'commands', 'agents', 'skills'], globalStateFile: 'auto', copyCredentials: false, overwrite: true },
};

function isPlainObject(v/*: unknown*/)/*: boolean*/ { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function merge(base/*: any*/, extra/*: any*/)/*: any*/ {
  const result = { ...base };
  for (const key of Object.keys(extra ?? {})) {
    result[key] = isPlainObject(base[key]) && isPlainObject(extra[key]) ? merge(base[key], extra[key]) : extra[key];
  }
  return result;
}

export function loadConfig(configPath/*: string*/)/*: LoadedConfig*/ {
  const full = path.resolve(configPath);
  if (!fs.existsSync(full)) fail('Config not found: ' + full);
  const config = merge(DEFAULTS, readJson/*<any>*/(full))/*as Config*/;
  if (config.version !== 2) fail('Unsupported config version ' + String(config.version) + ' (expected 2).');
  if (typeof config.storage?.root !== 'string') fail('storage.root is required.');
  const memory = config.sandbox.memoryMb;
  if (memory !== 'auto' && (!Number.isInteger(memory) || memory < 2048)) fail("sandbox.memoryMb must be 'auto' or an integer >= 2048.");
  if (!config.projects?.[config.defaultProject]) fail('defaultProject does not exist: ' + config.defaultProject);
  if (!config.harnesses?.[config.defaultHarness]) fail('defaultHarness does not exist: ' + config.defaultHarness);
  const base = path.dirname(full);
  for (const [name, project] of Object.entries(config.projects)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) fail('Invalid project name: ' + name);
    assertGuestPath(project.guestWorkspace);
    if (isRootPath(expandPath(project.workspace, base))) fail('Project workspace cannot be a drive root: ' + project.workspace);
    for (const mapping of project.mappings ?? []) assertGuestPath(mapping.guest);
  }
  for (const [name, harness] of Object.entries(config.harnesses)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) fail('Invalid harness name: ' + name);
    if (!harness.hostExecutable && !harness.npmPackage) fail('Harness ' + name + ' needs hostExecutable or npmPackage.');
    if (harness.npmPackage && !harness.npmBin) fail('Harness ' + name + ' needs npmBin when npmPackage is set.');
  }
  return { config, configPath: full, base };
}

export function assertNoGuestOverlap(mappings/*: { guest: string }[]*/)/*: void*/ {
  for (let i = 0; i < mappings.length; i++) {
    for (let j = i + 1; j < mappings.length; j++) {
      const a = mappings[i].guest.replace(/\\+$/, '').toLowerCase();
      const b = mappings[j].guest.replace(/\\+$/, '').toLowerCase();
      if (a === b || a.startsWith(b + '\\') || b.startsWith(a + '\\')) fail('Overlapping guest mappings: ' + mappings[i].guest + ' and ' + mappings[j].guest);
    }
  }
}
