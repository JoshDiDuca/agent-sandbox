import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeProfileConfig, ProfileResult } from '../core/types.js';
import { stripMcpServers, stripSettings, type SecretsConfig } from './secrets.js';
import { dirExists, ensureDir, fileExists, homeDir, readJson, writeJson } from '../core/util.js';

const MAX_BYTES = 250 * 1024 * 1024;

const directorySize = (dir: string): number => {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
};

const validJson = (file: string): boolean => {
  try { JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); return true; } catch { return false; }
};

export const hostClaudeDir = (settings: ClaudeProfileConfig): string => {
  return settings.hostDir === 'auto' ? (process.env.CLAUDE_CONFIG_DIR ?? path.join(homeDir(), '.claude')) : settings.hostDir;
};

export const hostGlobalStateFile = (settings: ClaudeProfileConfig): string => {
  if (settings.globalStateFile !== 'auto') return settings.globalStateFile;
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(homeDir(), '.claude.json');
};

/**
 * Copies SELECTED Claude settings from this PC into the launch folder. Conversation history is handled
 * separately by history.ts (it needs path translation), and the login only travels when copyCredentials is on.
 */
/**
 * What of your .claude.json the sandbox gets: everything except secrets and other projects. API keys and the account
 * block stay on this PC (logins travel only through `sandbox account`), and of the per-project entries only
 * this workspace's (with its MCP servers) is kept; other projects' entries can hold their MCP servers' tokens.
 */
export const sandboxGlobalState = (state: Record<string, unknown>, workspaceHost: string): Record<string, unknown> => {
  const { primaryApiKey: _key, customApiKeyResponses: _responses, oauthAccount: _account, projects, ...rest } = state;
  const same = (key: string): boolean => key.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === workspaceHost.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const own = Object.entries((projects ?? {}) as Record<string, unknown>).filter(([key]) => same(key));
  return { ...rest, projects: Object.fromEntries(own) };
};

export const stageClaudeProfile = (settings: ClaudeProfileConfig, launchPath: string, workspaceHost: string, secrets: SecretsConfig): ProfileResult => {
  const result: ProfileResult = { hostDir: null, staged: [], skipped: [], credentials: false, secretsRemoved: [] };
  if (!settings.enabled) return result;
  const hostDir = hostClaudeDir(settings);
  result.hostDir = hostDir;
  const target = path.join(launchPath, 'claude-profile');
  ensureDir(target);

  const items = [...settings.include];
  if (settings.copyCredentials) items.push('.credentials.json');
  for (const name of items) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') { result.skipped.push(name + ' (invalid name)'); continue; }
    const source = path.join(hostDir, name);
    const destination = path.join(target, name);
    if (fileExists(source)) {
      if (name.toLowerCase().endsWith('.json') && !validJson(source)) { result.skipped.push(name + ' (invalid JSON on host; fix or remove it)'); continue; }
      // Claude's settings can carry credentials in "env" and commands that fetch them; those stay here.
      if (/^settings(.local)?.json$/i.test(name)) writeJson(destination, stripSettings(readJson<Record<string, unknown>>(source), secrets, result.secretsRemoved));
      else fs.copyFileSync(source, destination);
    } else if (dirExists(source)) {
      if (directorySize(source) > MAX_BYTES) { result.skipped.push(name + ' (over 250 MB)'); continue; }
      fs.cpSync(source, destination, { recursive: true, force: true });
    } else {
      result.skipped.push(name + ' (not found)');
      continue;
    }
    result.staged.push(name);
    if (name === '.credentials.json') result.credentials = true;
  }

  if (settings.globalStateFile !== '') {
    const globalFile = hostGlobalStateFile(settings);
    if (!fileExists(globalFile)) result.skipped.push('.claude.json (not found)');
    else if (!validJson(globalFile)) result.skipped.push('.claude.json (invalid JSON on host)');
    else { writeJson(path.join(target, '.claude.json'), stripMcpServers(sandboxGlobalState(readJson<Record<string, unknown>>(globalFile), workspaceHost), secrets, result.secretsRemoved)); result.staged.push('.claude.json'); }
  }
  return result;
};
