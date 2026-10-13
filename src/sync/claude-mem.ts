// claude-mem data (~/.claude-mem) between this PC and the sandbox's persistent store.
//
// IN (this PC -> sandbox): the whole folder is mirrored; nothing flows to your PC in that direction.
// OUT (sandbox -> this PC), only with claudeProfile.syncClaudeMemBack: ONLY the SQLite database files come back. Never settings, never the Chroma vector store:
// Chroma keeps Python pickle files, and a crafted pickle runs code when loaded, so copying it back would let a
// compromised sandbox execute code on your PC. claude-mem rebuilds its vector index from the database by itself.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { dirExists, homeDir, isLink } from '../core/util/index.js';
import { safeRemove } from '../shared/io/index.js';
import { assertTestWritable } from '../host/test-guard.js';
import type { SyncState } from './sync-state.js';

// Never in: its settings (provider API keys), .env files and backups; nor run-time files that mean nothing elsewhere.
const SKIP_IN =
  /(^logs$|^backups?$|^settings\.json$|^\.env|\.pid$|\.port$|\.lock$|^worker.*\.json$|\.incoming$|\.conflict-\d+$)/i;
/** The only files that may come back from the sandbox. */
const DATABASE = /^claude-mem\.db(-wal|-shm)?$/i;
const MAX_DB_BYTES = 2 * 1024 * 1024 * 1024;

export type MemResult = 'none' | 'copied-in' | 'copied-out' | 'unchanged' | 'conflict';

export const hostClaudeMemDir = (): string => process.env.CLAUDE_MEM_DATA_DIR ?? path.join(homeDir(), '.claude-mem');

/** Plain database files at the top of a claude-mem folder (links and anything else are ignored). */
const databaseFiles = (dir: string): string[] =>
  dirExists(dir) && !isLink(dir)
    ? fs.readdirSync(dir).filter((f) => DATABASE.test(f) && fs.lstatSync(path.join(dir, f)).isFile())
    : [];

/** Newest database file time: the only thing that matters for deciding the direction. */
const stampOf = (dir: string): number =>
  _.max(databaseFiles(dir).map((f) => fs.statSync(path.join(dir, f)).mtimeMs)) ?? 0;

/** Host -> sandbox: replace the sandbox store with a copy of this PC's folder (staging folder, then swap). */
const mirrorIn = (hostDir: string, store: string): void => {
  const incoming = store + '.incoming';
  safeRemove(incoming, path.dirname(store));
  fs.cpSync(hostDir, incoming, {
    recursive: true,
    filter: (src: string) => src === hostDir || (!SKIP_IN.test(path.basename(src)) && !isLink(src)),
  });
  safeRemove(store, path.dirname(store));
  fs.renameSync(incoming, store);
};

/** Sandbox -> host: copy only the database files, each via a temp file + rename; everything else on this PC stays. */
const copyDatabaseOut = (store: string, hostDir: string): void => {
  fs.mkdirSync(hostDir, { recursive: true });
  for (const name of databaseFiles(store)) {
    const source = path.join(store, name);
    if (fs.statSync(source).size > MAX_DB_BYTES)
      throw new Error('claude-mem database in the sandbox is suspiciously large; not copied back: ' + source);
    const temp = path.join(hostDir, name + '.from-sandbox');
    fs.copyFileSync(source, temp);
    fs.renameSync(temp, path.join(hostDir, name));
  }
};

/** Keeps a copy of this PC's databases before they are replaced after both sides changed. */
const parkHostDatabases = (hostDir: string): void => {
  const parked = hostDir + '.conflict-' + Date.now();
  fs.mkdirSync(parked, { recursive: true });
  for (const name of databaseFiles(hostDir)) fs.copyFileSync(path.join(hostDir, name), path.join(parked, name));
};

/**
 * Direction is decided by which side's database changed since the last sync. If BOTH changed, the side about to be
 * overwritten is kept as `<dir>.conflict-<time>` first, so nothing is ever lost.
 */
export const syncClaudeMem = (hostDir: string, store: string, state: SyncState, direction: 'in' | 'out'): MemResult => {
  assertTestWritable(direction === 'in' ? store : hostDir);
  if (isLink(store)) throw new Error('Refusing to sync claude-mem: ' + store + ' is a link.');
  const hostStamp = stampOf(hostDir);
  const guestStamp = stampOf(store);
  if (hostStamp === 0 && guestStamp === 0 && !dirExists(hostDir)) return 'none';
  const hostChanged = hostStamp > (state.memHostStamp ?? 0) + 1;
  const guestChanged = state.memGuestStamp !== undefined && guestStamp > state.memGuestStamp + 1;
  let result: MemResult = 'unchanged';
  if (direction === 'in' && dirExists(hostDir) && (hostChanged || guestStamp === 0)) {
    if (guestChanged) fs.cpSync(store, store + '.conflict-' + Date.now(), { recursive: true });
    mirrorIn(hostDir, store);
    result = guestChanged ? 'conflict' : 'copied-in';
  } else if (direction === 'out' && guestChanged) {
    if (hostChanged) parkHostDatabases(hostDir);
    copyDatabaseOut(store, hostDir);
    result = hostChanged ? 'conflict' : 'copied-out';
  }
  state.memHostStamp = stampOf(hostDir);
  state.memGuestStamp = stampOf(store);
  return result;
};
