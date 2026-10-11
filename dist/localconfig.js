import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
//TS import type { Config, LocalConfigFile, Mapping, Overrides } from './types.js';
import { mergeConfig } from './config.js';
import { assertGuestPath, ensureDir, expandPath, fail, fileExists, readJson } from './util.js';

export const LOCAL_CONFIG_NAME = '.sandbox-config.json';

const SANDBOX_RULES/*: Record<string, string>*/ = { memoryMb: 'memory', maxMemoryMb: 'number', reserveHostMb: 'number', vGpu: 'boolean', networking: 'boolean', clipboard: 'boolean', audioInput: 'boolean', videoInput: 'boolean', printerRedirection: 'boolean', protectedClient: 'boolean' };
const NETWORK_RULES/*: Record<string, string>*/ = { blockPrivateRanges: 'boolean' };
const PROVISIONING_RULES/*: Record<string, string>*/ = { copyFromHost: 'boolean', fallbackToInstall: 'boolean', refresh: 'boolean' };
const PROVISIONING_NESTED/*: Record<string, Record<string, string>>*/ = { git: { enabled: 'boolean' }, terminal: { enabled: 'boolean', launchAgentInTerminal: 'boolean' }, node: { version: 'string' } };
const CLAUDE_RULES/*: Record<string, string>*/ = { enabled: 'boolean', include: 'stringArray', overwrite: 'boolean', copyCredentials: 'boolean' };
const HOOK_RULES/*: Record<string, string>*/ = { failFast: 'boolean' };
const TOP_LEVEL = ['harness', 'guestWorkspace', 'readOnly', 'mappings', 'scripts', 'sandbox', 'network', 'provisioning', 'claudeProfile', 'hooks'];

function isObject(v/*: unknown*/)/*: v is Record<string, unknown>*/ { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function isComment(key/*: string*/)/*: boolean*/ { return key.startsWith('_') || key.startsWith('$') || key.startsWith('//'); }
function valid(rule/*: string*/, v/*: unknown*/)/*: boolean*/ {
  switch (rule) {
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string' && v !== '';
    case 'number': return typeof v === 'number' && Number.isFinite(v) && v >= 0;
    case 'memory': return v === 'auto' || (typeof v === 'number' && Number.isInteger(v) && v >= 2048);
    case 'stringArray': return Array.isArray(v) && v.every((x/*: unknown*/) => typeof x === 'string');
    default: return false;
  }
}
function checkSection(name/*: string*/, value/*: unknown*/, rules/*: Record<string, string>*/, errors/*: string[]*/, nested/*: Record<string, Record<string, string>>*/ = {})/*: Record<string, unknown>*/ {
  const out/*: Record<string, unknown>*/ = {};
  if (!isObject(value)) { errors.push(name + ' must be an object'); return out; }
  for (const [key, v] of Object.entries(value)) {
    if (isComment(key)) continue;
    if (nested[key]) { out[key] = checkSection(name + '.' + key, v, nested[key], errors); continue; }
    const rule = rules[key];
    if (!rule) { errors.push(name + '.' + key + ' is not allowed here (allowed: ' + [...Object.keys(rules), ...Object.keys(nested)].join(', ') + ')'); continue; }
    if (!valid(rule, v)) { errors.push(name + '.' + key + ' has the wrong type or value (expected ' + rule + ')'); continue; }
    out[key] = v;
  }
  return out;
}

/** Validates a local/preset settings object. Only a safe subset of keys is accepted; host-path and executable settings are NOT. */
export function normalizeOverrides(data/*: unknown*/, dir/*: string*/, allowPreset/*: boolean*/, source/*: string*/)/*: Overrides*/ {
  if (!isObject(data)) fail(source + ' must contain a JSON object.');
  const errors/*: string[]*/ = [];
  const out/*: Overrides*/ = {};
  for (const [key, value] of Object.entries(data)) {
    if (isComment(key)) continue;
    switch (key) {
      case 'harness': if (valid('string', value)) out.harness = value/*as string*/; else errors.push('harness must be a non-empty string'); break;
      case 'guestWorkspace':
        if (!valid('string', value)) { errors.push('guestWorkspace must be a string'); break; }
        try { assertGuestPath(value/*as string*/); out.guestWorkspace = value/*as string*/; } catch (e) { errors.push('guestWorkspace: ' + (e instanceof Error ? e.message : String(e))); }
        break;
      case 'readOnly': if (valid('boolean', value)) out.readOnly = value/*as boolean*/; else errors.push('readOnly must be true or false'); break;
      case 'scripts':
        if (!valid('stringArray', value)) { errors.push('scripts must be an array of file paths'); break; }
        out.scripts = (value/*as string[]*/).map((s/*: string*/) => expandPath(s, dir));
        for (const s of out.scripts) if (!fileExists(s)) errors.push('scripts: file not found: ' + s);
        break;
      case 'mappings': {
        if (!Array.isArray(value)) { errors.push('mappings must be an array'); break; }
        const list/*: Mapping[]*/ = [];
        value.forEach((m/*: unknown*/, i/*: number*/) => {
          const where = 'mappings[' + i + ']';
          if (!isObject(m)) { errors.push(where + ' must be an object'); return; }
          const extra = Object.keys(m).filter((k/*: string*/) => !['host', 'guest', 'readOnly', 'optional'].includes(k) && !isComment(k));
          if (extra.length) errors.push(where + ' has unknown keys: ' + extra.join(', '));
          if (!valid('string', m.host) || !valid('string', m.guest) || !valid('boolean', m.readOnly)) { errors.push(where + ' needs host (string), guest (string) and readOnly (true/false)'); return; }
          if (m.optional !== undefined && !valid('boolean', m.optional)) { errors.push(where + '.optional must be true or false'); return; }
          try { assertGuestPath(m.guest/*as string*/); } catch (e) { errors.push(where + ': ' + (e instanceof Error ? e.message : String(e))); return; }
          list.push({ host: expandPath(m.host/*as string*/, dir), guest: m.guest/*as string*/, readOnly: m.readOnly/*as boolean*/, optional: m.optional === true });
        });
        out.mappings = list;
        break;
      }
      case 'sandbox': out.sandbox = checkSection('sandbox', value, SANDBOX_RULES, errors); break;
      case 'network': out.network = checkSection('network', value, NETWORK_RULES, errors); break;
      case 'provisioning': out.provisioning = checkSection('provisioning', value, PROVISIONING_RULES, errors, PROVISIONING_NESTED); break;
      case 'claudeProfile': out.claudeProfile = checkSection('claudeProfile', value, CLAUDE_RULES, errors); break;
      case 'hooks': out.hooks = checkSection('hooks', value, HOOK_RULES, errors); break;
      case 'workspace':
        if (!allowPreset) { errors.push('workspace is only allowed in config.json project presets (the folder you run from IS the workspace)'); break; }
        if (valid('string', value)) out.workspace = expandPath(value/*as string*/, dir); else errors.push('workspace must be a string');
        break;
      case 'createWorkspace':
        if (!allowPreset) { errors.push('createWorkspace is only allowed in config.json project presets'); break; }
        if (valid('boolean', value)) out.createWorkspace = value/*as boolean*/; else errors.push('createWorkspace must be true or false');
        break;
      default: errors.push(key + ' is not an allowed setting (allowed: ' + TOP_LEVEL.join(', ') + ')');
    }
  }
  if (errors.length) fail(source + ' is not valid:\n  - ' + errors.join('\n  - '));
  return out;
}

export function applyOverrides(config/*: Config*/, ov/*: Overrides*/)/*: Config*/ {
  const next/*: Config*/ = structuredClone(config);
  if (ov.harness) next.defaultHarness = ov.harness;
  if (ov.guestWorkspace) next.guestWorkspace = ov.guestWorkspace;
  if (ov.readOnly !== undefined) next.readOnly = ov.readOnly;
  if (ov.mappings) {
    const replaced = new Set(ov.mappings.map((m/*: Mapping*/) => m.guest.toLowerCase()));
    next.mappings = [...next.mappings.filter((m/*: Mapping*/) => !replaced.has(m.guest.toLowerCase())), ...ov.mappings];
  }
  if (ov.sandbox) next.sandbox = mergeConfig(next.sandbox, ov.sandbox);
  if (ov.network) next.network = mergeConfig(next.network, ov.network);
  if (ov.provisioning) next.provisioning = mergeConfig(next.provisioning, ov.provisioning);
  if (ov.claudeProfile) next.claudeProfile = mergeConfig(next.claudeProfile, ov.claudeProfile);
  if (ov.hooks) next.hooks = mergeConfig(next.hooks, ov.hooks);
  return next;
}

function flatten(prefix/*: string*/, value/*: unknown*/, lines/*: string[]*/)/*: void*/ {
  if (isObject(value)) { for (const [k, v] of Object.entries(value)) flatten(prefix + '.' + k, v, lines); return; }
  lines.push(prefix + ' = ' + JSON.stringify(value));
}
export function describeOverrides(ov/*: Overrides*/)/*: string[]*/ {
  const lines/*: string[]*/ = [];
  if (ov.harness) lines.push('agent = ' + ov.harness);
  if (ov.guestWorkspace) lines.push('guestWorkspace = ' + ov.guestWorkspace);
  if (ov.readOnly !== undefined) lines.push('workspace read-only = ' + ov.readOnly);
  for (const m of ov.mappings ?? []) lines.push((m.readOnly ? 'read-only' : 'READ/WRITE') + ' folder ' + m.host + '  ->  ' + m.guest);
  for (const s of ov.scripts ?? []) lines.push('runs inside the sandbox: ' + s);
  for (const section of ['sandbox', 'network', 'provisioning', 'claudeProfile', 'hooks']) flatten(section, (ov/*as Record<string, unknown>*/)[section] ?? {}, lines);
  const risky/*: string[]*/ = [];
  if (ov.claudeProfile?.copyCredentials === true) risky.push('claudeProfile.copyCredentials = true copies your Claude LOGIN into the sandbox');
  if (ov.network?.blockPrivateRanges === false) risky.push('network.blockPrivateRanges = false turns OFF the LAN block');
  if ((ov.mappings ?? []).some((m/*: Mapping*/) => !m.readOnly)) risky.push('a READ/WRITE mapping lets the agent change files outside your workspace');
  return [...lines, ...risky.map((r/*: string*/) => '!! ' + r)];
}

export function readLocalConfig(dir/*: string*/)/*: LocalConfigFile | null*/ {
  const file = path.join(dir, LOCAL_CONFIG_NAME);
  if (!fileExists(file)) return null;
  const raw = fs.readFileSync(file);
  let data/*: unknown*/;
  try { data = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch (e) { fail(file + ' is not valid JSON: ' + (e instanceof Error ? e.message : String(e))); }
  return { path: file, hash: crypto.createHash('sha256').update(raw).digest('hex'), data };
}

export function trustStorePath(storageRoot/*: string*/)/*: string*/ { return path.join(storageRoot, 'trusted-configs.json'); }
function loadTrust(storeFile/*: string*/)/*: Record<string, string>*/ { try { return readJson/*<Record<string, string>>*/(storeFile); } catch { return {}; } }
export function isTrusted(storeFile/*: string*/, filePath/*: string*/, hash/*: string*/)/*: boolean*/ { return loadTrust(storeFile)[path.resolve(filePath).toLowerCase()] === hash; }
export function saveTrust(storeFile/*: string*/, filePath/*: string*/, hash/*: string*/)/*: void*/ {
  const store = loadTrust(storeFile);
  store[path.resolve(filePath).toLowerCase()] = hash;
  ensureDir(path.dirname(storeFile));
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + '\n', 'utf8');
}
