// Using another user's running sandbox: where its data folder is (taken from their record, so checked as untrusted
// input) and which projects it has.
import path from 'node:path';
import { assertNoLinks, fail } from '../../core/util/index.js';
import type { ActiveSandbox } from './active-record.js';
import { machineRoot } from './machine-paths.js';
import { ownerName } from './rules.js';

/** Another user's sandbox that is shared with this user: their name and the record they wrote. */
export interface Borrowed {
  readonly user: string;
  readonly record: ActiveSandbox;
}

/**
 * The data folder from a record. It must be machine\users\<name>\data\<set> and no link may be on the way: the record
 * is written by another user, so it cannot send this user's CLI to any other folder.
 */
export function sharedDataPath(record: ActiveSandbox, machine: string = machineRoot()): string {
  const users = path.join(machine, 'users');
  const dataPath = path.resolve(record.dataPath);
  const parts = path.relative(users, dataPath).split(path.sep);
  const inside = parts.length === 3 && parts[1].toLowerCase() === 'data' && parts.every((p) => p && p !== '..');
  if (!inside || path.isAbsolute(path.relative(users, dataPath)))
    fail(
      'The record of ' + ownerName(record.user) + "'s sandbox points outside the shared folder, so it is not used.",
      'Ask them to restart their sandbox.',
    );
  assertNoLinks(users, dataPath);
  return dataPath;
}
