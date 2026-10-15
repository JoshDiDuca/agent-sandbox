// Claude settings from this PC, plugin path fix-up, and the claude-mem working copy.
import fs from 'node:fs';
import path from 'node:path';
import { translatePaths } from '../../shared/paths/claude-paths.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { safeRemove } from '../../shared/io/safe-remove.js';
import { claudeDir, session, workspace } from '../runtime/session.js';
import { launchDir } from '../runtime/paths.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log, warn } from '../runtime/log.js';

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

type ClaudeState = {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
} & Record<string, unknown>;

const readState = (file: string): ClaudeState | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as ClaudeState;
  } catch {
    return null;
  }
};
const sameFolder = (a: string, b: string): boolean =>
  a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * The sandbox keeps its own .claude.json (login, onboarding, per-project state), so MCP servers from this PC are
 * merged into it each boot: user-scope `mcpServers`, and this project's local-scope servers under the sandbox path.
 * Servers with the same name are replaced by this PC's definition; servers added inside the sandbox are kept.
 */
export function mergeMcpServers(
  hostFile: string,
  guestFile: string,
  hostWorkspace: string,
  guestWorkspace: string,
): number {
  const host = readState(hostFile);
  const guest = readState(guestFile);
  if (!host || !guest) return 0;
  const hostProject =
    Object.entries(host.projects ?? {}).find(([key]) => sameFolder(key, hostWorkspace))?.[1]?.mcpServers ?? {};
  const projects = { ...(guest.projects ?? {}) };
  const guestKey =
    Object.keys(projects).find((key) => sameFolder(key, guestWorkspace)) ?? guestWorkspace.replace(/\\/g, '/');
  projects[guestKey] = {
    ...(projects[guestKey] ?? {}),
    mcpServers: { ...(projects[guestKey]?.mcpServers ?? {}), ...hostProject },
  };
  const merged: ClaudeState = {
    ...guest,
    mcpServers: { ...(guest.mcpServers ?? {}), ...(host.mcpServers ?? {}) },
    projects,
  };
  writeJsonAtomic(guestFile, merged);
  return Object.keys(host.mcpServers ?? {}).length + Object.keys(hostProject).length;
}

/** `credentials`: the text of this PC's .credentials.json, handed over in the one-shot secrets file. */
export function syncClaudeProfile(credentials?: string): void {
  const profile = session.claudeProfile;
  if (profile.items.length === 0) {
    log('No Claude settings were staged from this PC.');
    return;
  }
  const source = path.join(launchDir, 'claude-profile');
  mkdirp(claudeDir);
  for (const name of profile.items) {
    const from = path.join(source, name);
    const to = path.join(claudeDir, name);
    if (name === '.credentials.json') {
      // Never staged in the launch folder: it came in the secrets file.
      if (credentials && !exists(to)) {
        fs.writeFileSync(to, credentials, 'utf8');
        log('Claude settings: copied ' + name + ' from this PC');
      } else log("Claude settings: kept the sandbox's " + name);
      continue;
    }
    if (!exists(from)) continue;
    if ((KEEP_SANDBOX_COPY.includes(name) || !profile.overwrite) && exists(to)) {
      log("Claude settings: kept the sandbox's " + name);
      continue;
    }
    // Folders (skills, commands, plugins) are mirrored: what was removed on this PC goes here too.
    if (fs.statSync(from).isDirectory()) safeRemove(to, claudeDir);
    fs.cpSync(from, to, { recursive: true, force: true });
    log('Claude settings: copied ' + name + ' from this PC');
  }
  fixPluginPaths(profile.hostConfigDir);
  const mcp = mergeMcpServers(
    path.join(source, '.claude.json'),
    path.join(claudeDir, '.claude.json'),
    session.workspaceHost,
    workspace,
  );
  if (mcp) log('Claude settings: ' + mcp + ' MCP server(s) from this PC merged in');
  if (profile.credentials) warn('Your host Claude LOGIN was copied into the sandbox (copyCredentials is true).');
}
