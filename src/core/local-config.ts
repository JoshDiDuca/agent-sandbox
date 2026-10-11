import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config, LocalConfigFile, Mapping, Overrides } from './types.js';
import { mergeConfig } from './config.js';
import { assertGuestPath, ensureDir, errMsg, expandPath, fail, fileExists, tryReadJson } from './util.js';

export const LOCAL_CONFIG_NAME = '.sandbox-config.json';

type Rule = 'boolean' | 'string' | 'number' | 'memory' | 'stringArray';
interface Section { rules: Record<string, Rule>; nested?: Record<string, Section> }

const SECTIONS: Record<string, Section> = {
  sandbox: { rules: { memoryMb: 'memory', maxMemoryMb: 'number', reserveHostMb: 'number', vGpu: 'boolean', networking: 'boolean', clipboard: 'boolean', audioInput: 'boolean', videoInput: 'boolean', printerRedirection: 'boolean', protectedClient: 'boolean', headless: 'boolean' } },
  network: { rules: { blockPrivateRanges: 'boolean' } },
  provisioning: { rules: { copyFromHost: 'boolean', fallbackToInstall: 'boolean', refresh: 'boolean' }, nested: { git: { rules: { enabled: 'boolean' } }, terminal: { rules: { enabled: 'boolean' } } } },
  toolchains: {
    rules: {},
    nested: {
      node: { rules: { version: 'string', extraVersions: 'stringArray' } },
      python: { rules: { enabled: 'boolean', version: 'string', python2: 'boolean' } },
      rust: { rules: { enabled: 'boolean', toolchain: 'string', host: 'string' } },
      cpp: { rules: { enabled: 'boolean' } },
      dotnet: { rules: { enabled: 'boolean', channels: 'stringArray' } },
      bun: { rules: { enabled: 'boolean' } },
      uv: { rules: { enabled: 'boolean' } },
    },
  },
  attach: { rules: { enabled: 'boolean' } },
  personalization: { rules: { enabled: 'boolean' } },
  claudeProfile: { rules: { enabled: 'boolean', include: 'stringArray', overwrite: 'boolean', copyCredentials: 'boolean', syncHistory: 'boolean', syncClaudeMem: 'boolean' } },
  hooks: { rules: { failFast: 'boolean' } },
};
const TOP_LEVEL = ['harness', 'guestWorkspace', 'readOnly', 'mappings', 'scripts', ...Object.keys(SECTIONS)];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isComment = (key: string): boolean => key.startsWith('_') || key.startsWith('$') || key.startsWith('//');

const valid = (rule: Rule, v: unknown): boolean => {
  switch (rule) {
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string' && v !== '';
    case 'number': return typeof v === 'number' && Number.isFinite(v) && v >= 0;
    case 'memory': return v === 'auto' || (typeof v === 'number' && Number.isInteger(v) && v >= 2048);
    case 'stringArray': return Array.isArray(v) && v.every((x: unknown) => typeof x === 'string');
  }
};

const checkSection = (name: string, value: unknown, section: Section, errors: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (!isObject(value)) { errors.push(name + ' must be an object'); return out; }
  for (const [key, v] of Object.entries(value)) {
    if (isComment(key)) continue;
    const nested = section.nested?.[key];
    if (nested) { out[key] = checkSection(name + '.' + key, v, nested, errors); continue; }
    const rule = section.rules[key];
    if (!rule) { errors.push(name + '.' + key + ' is not allowed here (allowed: ' + [...Object.keys(section.rules), ...Object.keys(section.nested ?? {})].join(', ') + ')'); continue; }
    if (!valid(rule, v)) { errors.push(name + '.' + key + ' has the wrong type or value (expected ' + rule + ')'); continue; }
    out[key] = v;
  }
  return out;
};

const checkMappings = (value: unknown, dir: string, errors: string[]): Mapping[] => {
  if (!Array.isArray(value)) { errors.push('mappings must be an array'); return []; }
  const list: Mapping[] = [];
  value.forEach((m: unknown, i: number) => {
    const where = 'mappings[' + i + ']';
    if (!isObject(m)) { errors.push(where + ' must be an object'); return; }
    const extra = Object.keys(m).filter((k: string) => !['host', 'guest', 'readOnly', 'optional'].includes(k) && !isComment(k));
    if (extra.length) errors.push(where + ' has unknown keys: ' + extra.join(', '));
    if (!valid('string', m.host) || !valid('string', m.guest) || !valid('boolean', m.readOnly)) { errors.push(where + ' needs host (string), guest (string) and readOnly (true/false)'); return; }
    if (m.optional !== undefined && !valid('boolean', m.optional)) { errors.push(where + '.optional must be true or false'); return; }
    try { assertGuestPath(m.guest as string); } catch (e) { errors.push(where + ': ' + errMsg(e)); return; }
    list.push({ host: expandPath(m.host as string, dir), guest: m.guest as string, readOnly: m.readOnly as boolean, optional: m.optional === true });
  });
  return list;
};

/** Validates a folder's settings. Only a safe subset of keys is accepted; host paths and executables are NOT. */
export const normalizeOverrides = (data: unknown, dir: string, source: string): Overrides => {
  if (!isObject(data)) fail(source + ' must contain a JSON object.');
  const errors: string[] = [];
  const out: Overrides = {};
  for (const [key, value] of Object.entries(data)) {
    if (isComment(key)) continue;
    if (key in SECTIONS) { (out as Record<string, unknown>)[key] = checkSection(key, value, SECTIONS[key], errors); continue; }
    switch (key) {
      case 'harness': if (valid('string', value)) out.harness = value as string; else errors.push('harness must be a non-empty string'); break;
      case 'readOnly': if (valid('boolean', value)) out.readOnly = value as boolean; else errors.push('readOnly must be true or false'); break;
      case 'guestWorkspace':
        if (!valid('string', value)) { errors.push('guestWorkspace must be a string'); break; }
        try { if (value !== 'auto') assertGuestPath(value as string); out.guestWorkspace = value as string; } catch (e) { errors.push('guestWorkspace: ' + errMsg(e)); }
        break;
      case 'scripts':
        if (!valid('stringArray', value)) { errors.push('scripts must be an array of file paths'); break; }
        out.scripts = (value as string[]).map((s: string) => expandPath(s, dir));
        for (const s of out.scripts) if (!fileExists(s)) errors.push('scripts: file not found: ' + s);
        break;
      case 'mappings': out.mappings = checkMappings(value, dir, errors); break;
      default: errors.push(key + ' is not an allowed setting (allowed: ' + TOP_LEVEL.join(', ') + ')');
    }
  }
  if (errors.length) fail(source + ' is not valid:\n  - ' + errors.join('\n  - '));
  return out;
};

export const applyOverrides = (config: Config, ov: Overrides): Config => {
  let next: Config = structuredClone(config);
  if (ov.harness) next.defaultHarness = ov.harness;
  if (ov.guestWorkspace) next.guestWorkspace = ov.guestWorkspace;
  if (ov.readOnly !== undefined) next.readOnly = ov.readOnly;
  if (ov.mappings) {
    const replaced = new Set(ov.mappings.map((m: Mapping) => m.guest.toLowerCase()));
    next.mappings = [...next.mappings.filter((m: Mapping) => !replaced.has(m.guest.toLowerCase())), ...ov.mappings];
  }
  for (const section of Object.keys(SECTIONS)) {
    const value = (ov as Record<string, unknown>)[section];
    if (value) next = mergeConfig(next, { [section]: value });
  }
  return next;
};

const flatten = (prefix: string, value: unknown, lines: string[]): void => {
  if (isObject(value)) { for (const [k, v] of Object.entries(value)) flatten(prefix + '.' + k, v, lines); return; }
  lines.push(prefix + ' = ' + JSON.stringify(value));
};

/** Human-readable list of what a local config changes, with risky items flagged. */
export const describeOverrides = (ov: Overrides): string[] => {
  const lines: string[] = [];
  if (ov.harness) lines.push('agent = ' + ov.harness);
  if (ov.guestWorkspace) lines.push('guestWorkspace = ' + ov.guestWorkspace);
  if (ov.readOnly !== undefined) lines.push('workspace read-only = ' + ov.readOnly);
  for (const m of ov.mappings ?? []) lines.push((m.readOnly ? 'read-only' : 'READ/WRITE') + ' folder ' + m.host + '  ->  ' + m.guest);
  for (const s of ov.scripts ?? []) lines.push('runs inside the sandbox: ' + s);
  for (const section of Object.keys(SECTIONS)) flatten(section, (ov as Record<string, unknown>)[section] ?? {}, lines);
  const risky: string[] = [];
  if (ov.claudeProfile?.copyCredentials === true) risky.push('claudeProfile.copyCredentials = true copies your Claude LOGIN into the sandbox');
  if (ov.network?.blockPrivateRanges === false) risky.push('network.blockPrivateRanges = false turns OFF the LAN block');
  if ((ov.mappings ?? []).some((m: Mapping) => !m.readOnly)) risky.push('a READ/WRITE mapping lets the agent change files outside your workspace');
  return [...lines, ...risky.map((r: string) => '!! ' + r)];
};

export const readLocalConfig = (dir: string): LocalConfigFile | null => {
  const file = path.join(dir, LOCAL_CONFIG_NAME);
  if (!fileExists(file)) return null;
  const raw = fs.readFileSync(file);
  let data: unknown;
  try { data = JSON.parse(raw.toString('utf8').replace(/^﻿/, '')); } catch (e) { fail(file + ' is not valid JSON: ' + errMsg(e)); }
  return { path: file, hash: crypto.createHash('sha256').update(raw).digest('hex'), data };
};

export const trustStorePath = (storageRoot: string): string => path.join(storageRoot, 'trusted-configs.json');
const loadTrust = (storeFile: string): Record<string, string> => tryReadJson<Record<string, string>>(storeFile) ?? {};
export const isTrusted = (storeFile: string, filePath: string, hash: string): boolean => loadTrust(storeFile)[path.resolve(filePath).toLowerCase()] === hash;
export const saveTrust = (storeFile: string, filePath: string, hash: string): void => {
  const store = loadTrust(storeFile);
  store[path.resolve(filePath).toLowerCase()] = hash;
  ensureDir(path.dirname(storeFile));
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + '\n', 'utf8');
};
