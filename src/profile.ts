import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeProfileConfig, ProfileResult } from './types.js';
import { dirExists, ensureDir, fileExists } from './util.js';

const MAX_BYTES = 50 * 1024 * 1024;

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
}

function validJson(file: string): boolean {
  try { JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); return true; } catch { return false; }
}

/** Copies SELECTED Claude settings from this PC into the launch folder (never maps your whole ~/.claude, so history is not exposed). */
export function stageClaudeProfile(settings: ClaudeProfileConfig, launchPath: string): ProfileResult {
  const result: ProfileResult = { hostDir: null, staged: [], skipped: [], credentials: false };
  if (!settings.enabled) return result;
  const home = process.env.USERPROFILE ?? os.homedir();
  const hostDir = settings.hostDir === 'auto' ? (process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude')) : settings.hostDir;
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
      fs.copyFileSync(source, destination);
    } else if (dirExists(source)) {
      if (directorySize(source) > MAX_BYTES) { result.skipped.push(name + ' (over 50 MB)'); continue; }
      fs.cpSync(source, destination, { recursive: true, force: true });
    } else {
      result.skipped.push(name + ' (not found)');
      continue;
    }
    result.staged.push(name);
    if (name === '.credentials.json') result.credentials = true;
  }

  if (settings.globalStateFile !== '') {
    const globalFile = settings.globalStateFile === 'auto' ? (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json')) : settings.globalStateFile;
    if (!fileExists(globalFile)) result.skipped.push('.claude.json (not found)');
    else if (!validJson(globalFile)) result.skipped.push('.claude.json (invalid JSON on host)');
    else { fs.copyFileSync(globalFile, path.join(target, '.claude.json')); result.staged.push('.claude.json'); }
  }
  return result;
}
