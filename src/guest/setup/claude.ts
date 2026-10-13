// Claude settings from this PC, plugin path fix-up, and the claude-mem working copy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { translatePaths } from '../../shared/paths/claude-paths.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { safeRemove } from '../../shared/io/safe-remove.js';
import {
  claudeDir,
  dryRun,
  exists,
  launchDir,
  log,
  mkdirp,
  robocopy,
  session,
  stateDir,
  warn,
  workspace,
} from '../env.js';

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
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as ClaudeState;
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
export const mergeMcpServers = (
  hostFile: string,
  guestFile: string,
  hostWorkspace: string,
  guestWorkspace: string,
): number => {
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
};

export const syncClaudeProfile = (): void => {
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
};

/**
 * claude-mem keeps SQLite + a vector store. They run from the sandbox's own disk (SQLite and mapped folders do not
 * mix) and are mirrored to persistent storage, from where the host syncs them back to your PC.
 */
export const claudeMemPaths = {
  store: path.join(stateDir, 'claude-mem'),
  local: path.join(os.homedir(), '.claude-mem'),
};

const claudeMemEnabled = (): boolean => session.claudeProfile.syncClaudeMem && !dryRun;

export const restoreClaudeMem = (): void => {
  if (!claudeMemEnabled()) return;
  // A save cut off between its two renames (see saveClaudeMem) leaves only the aside copy: it is the newest data.
  const previous = claudeMemPaths.store + '.previous';
  if (!exists(claudeMemPaths.store) && exists(previous)) fs.renameSync(previous, claudeMemPaths.store);
  // A store that is gone or damaged: the newest backup that is a real database.
  const backups = claudeMemPaths.store + '.backups';
  if (!looksLikeSqlite(path.join(claudeMemPaths.store, 'claude-mem.db')) || !exists(claudeMemPaths.store)) {
    const good = (exists(backups) ? fs.readdirSync(backups).sort().reverse() : []).find(
      (b) => exists(path.join(backups, b, 'claude-mem.db')) && looksLikeSqlite(path.join(backups, b, 'claude-mem.db')),
    );
    if (good) {
      if (exists(claudeMemPaths.store))
        fs.renameSync(claudeMemPaths.store, claudeMemPaths.store + '.damaged-' + Date.now());
      fs.cpSync(path.join(backups, good), claudeMemPaths.store, { recursive: true });
      warn(
        'claude-mem: the stored database was missing or damaged; restored the backup from ' +
          new Date(Number(good)).toISOString() +
          '.',
      );
    }
  }
  if (!exists(claudeMemPaths.store)) return;
  robocopy(claudeMemPaths.store, claudeMemPaths.local);
  log('claude-mem data restored from persistent storage.');
};

/** Size + mtime of every SQLite database and -wal file under `dir`: when these have not moved, nothing was written. */
const databaseFingerprint = (dir: string): string => {
  const parts: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(db|sqlite3?)(-wal)?$/i.test(entry.name)) {
        const s = fs.statSync(full);
        parts.push(full + ':' + s.size + ':' + s.mtimeMs);
      }
    }
  };
  walk(dir);
  return parts.sort().join('|');
};

/** The databases as of the last save by this process (null: not saved yet, so the first save always copies). */
let lastSaved: string | null = null;

/**
 * Copies the live claude-mem folder back to persistent storage (staging folder + swap, never a half copy). Called from
 * the daemon tick: when no database changed since the last save it does nothing (no copy of the whole folder).
 */
const SQLITE_HEADER = 'SQLite format 3\0';
/** A database file that starts like SQLite and is not empty (a missing one counts as fine: nothing to protect yet). */
const looksLikeSqlite = (file: string): boolean => {
  if (!exists(file)) return true;
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    return fs.readSync(fd, head, 0, 16, 0) === 16 && head.toString('latin1') === SQLITE_HEADER;
  } finally {
    fs.closeSync(fd);
  }
};

const MAX_BACKUPS = 3;
const BACKUP_EVERY_MS = 6 * 3600 * 1000;
/** Moves the replaced copy into `dir` as a dated backup (at most one per 6 hours, the newest 3 kept); else deletes it. */
const keepBackup = (previous: string, dir: string): void => {
  if (!exists(previous)) return;
  const backups = exists(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => /^\d{13}$/.test(n))
        .sort()
    : [];
  const newest = Number(backups[backups.length - 1] ?? 0);
  if (Date.now() - newest < BACKUP_EVERY_MS) {
    fs.rmSync(previous, { recursive: true, force: true });
    return;
  }
  fs.renameSync(previous, path.join(mkdirp(dir), String(Date.now())));
  for (const old of [...backups, String(Date.now())].slice(0, -MAX_BACKUPS))
    fs.rmSync(path.join(dir, old), { recursive: true, force: true });
};

export const saveClaudeMem = (): void => {
  if (!claudeMemEnabled() || !exists(claudeMemPaths.local)) return;
  const { store, local } = claudeMemPaths;
  const fingerprint = databaseFingerprint(local);
  if (fingerprint === lastSaved && exists(store)) return;
  // A damaged copy (zero-filled after a crash, cut short) must never replace the store: that once destroyed the only copy.
  if (!looksLikeSqlite(path.join(local, 'claude-mem.db'))) {
    warn(
      'claude-mem: the local database does not look valid, so it was not saved over the stored copy (' + local + ').',
    );
    return;
  }
  const incoming = store + '.incoming';
  const previous = store + '.previous';
  fs.rmSync(incoming, { recursive: true, force: true });
  // The database, its -wal and -shm files are copied together, so the copy is consistent with itself.
  fs.cpSync(local, incoming, { recursive: true, filter: (src) => !/\.(pid|lock)$/i.test(src) });
  // Swap without a window where no copy exists: old aside, new in, then keep the old one as a dated backup.
  fs.rmSync(previous, { recursive: true, force: true });
  if (exists(store)) fs.renameSync(store, previous);
  try {
    fs.renameSync(incoming, store);
  } catch (e) {
    if (exists(previous)) fs.renameSync(previous, store);
    throw e;
  }
  keepBackup(previous, store + '.backups');
  lastSaved = fingerprint;
};
