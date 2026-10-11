// Claude settings from this PC, plugin path fix-up, and the claude-mem working copy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { translatePaths } from '../../shared/paths.js';
import { claudeDir, dryRun, exists, launchDir, log, mkdirp, robocopy, session, stateDir, warn, workspace } from '../env.js';

/** The sandbox keeps its own login and global state; everything else is refreshed from this PC each boot. */
const KEEP_SANDBOX_COPY = ['.claude.json', '.credentials.json'];

/** Plugin manifests store absolute paths to the plugin cache; point them at the sandbox's Claude folder. */
const fixPluginPaths = (hostConfigDir: string | null): void => {
  const plugins = path.join(claudeDir, 'plugins');
  if (!hostConfigDir || !exists(plugins)) return;
  for (const name of fs.readdirSync(plugins).filter((f) => f.endsWith('.json'))) {
    const file = path.join(plugins, name);
    const text = fs.readFileSync(file, 'utf8');
    const fixed = translatePaths(text, hostConfigDir, claudeDir);
    if (fixed !== text) fs.writeFileSync(file, fixed, 'utf8');
  }
};

type ClaudeState = { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> } & Record<string, unknown>;

const readState = (file: string): ClaudeState | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as ClaudeState; } catch { return null; } };
const sameFolder = (a: string, b: string): boolean => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * The sandbox keeps its own .claude.json (login, onboarding, per-project state), so MCP servers from this PC are
 * merged into it each boot: user-scope `mcpServers`, and this project's local-scope servers under the sandbox path.
 * Servers with the same name are replaced by this PC's definition; servers added inside the sandbox are kept.
 */
export const mergeMcpServers = (hostFile: string, guestFile: string, hostWorkspace: string, guestWorkspace: string): number => {
  const host = readState(hostFile);
  const guest = readState(guestFile);
  if (!host || !guest) return 0;
  const hostProject = Object.entries(host.projects ?? {}).find(([key]) => sameFolder(key, hostWorkspace))?.[1]?.mcpServers ?? {};
  const projects = { ...(guest.projects ?? {}) };
  const guestKey = Object.keys(projects).find((key) => sameFolder(key, guestWorkspace)) ?? guestWorkspace.replace(/\\/g, '/');
  projects[guestKey] = { ...(projects[guestKey] ?? {}), mcpServers: { ...(projects[guestKey]?.mcpServers ?? {}), ...hostProject } };
  const merged: ClaudeState = { ...guest, mcpServers: { ...(guest.mcpServers ?? {}), ...(host.mcpServers ?? {}) }, projects };
  fs.writeFileSync(guestFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return Object.keys(host.mcpServers ?? {}).length + Object.keys(hostProject).length;
};

export const syncClaudeProfile = (): void => {
  const profile = session.claudeProfile;
  if (profile.items.length === 0) { log('No Claude settings were staged from this PC.'); return; }
  const source = path.join(launchDir, 'claude-profile');
  mkdirp(claudeDir);
  for (const name of profile.items) {
    const from = path.join(source, name);
    const to = path.join(claudeDir, name);
    if (!exists(from)) continue;
    if ((KEEP_SANDBOX_COPY.includes(name) || !profile.overwrite) && exists(to)) { log('Claude settings: kept the sandbox\'s ' + name); continue; }
    fs.cpSync(from, to, { recursive: true, force: true });
    log('Claude settings: copied ' + name + ' from this PC');
  }
  fixPluginPaths(profile.hostConfigDir);
  const mcp = mergeMcpServers(path.join(source, '.claude.json'), path.join(claudeDir, '.claude.json'), session.workspaceHost, workspace);
  if (mcp) log('Claude settings: ' + mcp + ' MCP server(s) from this PC merged in');
  if (profile.credentials) warn('Your host Claude LOGIN was copied into the sandbox (copyCredentials is true).');
};

/**
 * claude-mem keeps SQLite + a vector store. They run from the sandbox's own disk (SQLite and mapped folders do not
 * mix) and are mirrored to persistent storage, from where the host syncs them back to your PC.
 */
export const claudeMemPaths = { store: path.join(stateDir, 'claude-mem'), local: path.join(os.homedir(), '.claude-mem') };

const claudeMemEnabled = (): boolean => session.claudeProfile.syncClaudeMem && !dryRun;

export const restoreClaudeMem = (): void => {
  if (!claudeMemEnabled() || !exists(claudeMemPaths.store)) return;
  robocopy(claudeMemPaths.store, claudeMemPaths.local);
  log('claude-mem data restored from persistent storage.');
};

/** Copies the live claude-mem folder back to persistent storage (staging folder + swap, never a half copy). */
export const saveClaudeMem = (): void => {
  if (!claudeMemEnabled() || !exists(claudeMemPaths.local)) return;
  const { store, local } = claudeMemPaths;
  const incoming = store + '.incoming';
  const previous = store + '.previous';
  fs.rmSync(incoming, { recursive: true, force: true });
  // The database, its -wal and -shm files are copied together, so the copy is consistent with itself.
  fs.cpSync(local, incoming, { recursive: true, filter: (src) => !/\.(pid|lock)$/i.test(src) });
  // Swap without a window where no copy exists: old aside, new in, then drop the old one.
  fs.rmSync(previous, { recursive: true, force: true });
  if (exists(store)) fs.renameSync(store, previous);
  try { fs.renameSync(incoming, store); } catch (e) { if (exists(previous)) fs.renameSync(previous, store); throw e; }
  fs.rmSync(previous, { recursive: true, force: true });
};
