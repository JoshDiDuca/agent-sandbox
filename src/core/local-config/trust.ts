import path from 'node:path';
import _ from 'lodash';
import { z } from 'zod';
import { tryReadJson, writeJson } from '../util/index.js';

// ---- approvals (host-only: <storage>\trusted-configs.json) ----------------------------------------------------------

export const trustStorePath = (storageRoot: string): string => path.join(storageRoot, 'trusted-configs.json');
const loadTrust = (store: string): Record<string, string> => tryReadJson<Record<string, string>>(store) ?? {};
const key = (file: string): string => path.resolve(file).toLowerCase();
export const isTrusted = (store: string, file: string, hash: string): boolean => loadTrust(store)[key(file)] === hash;
export const saveTrust = (store: string, file: string, hash: string): void =>
  writeJson(store, { ...loadTrust(store), [key(file)]: hash });

// ---- looser settings you allowed for one project (host-only: <storage>\allowed-requests.json) ----------------------
// A project file can never loosen a protection by itself. When it asks, you are asked once (interactively); a "yes"
// is kept here, per project file and per "setting = value", so only that value is ever let through for that project.

export const allowStorePath = (storageRoot: string): string => path.join(storageRoot, 'allowed-requests.json');
const loadAllowed = (store: string): Record<string, string[]> => {
  const parsed = z
    .record(z.string(), z.array(z.string().max(2000)).max(500))
    .safeParse(tryReadJson<unknown>(store) ?? {});
  return parsed.success ? parsed.data : {};
};
const allowKey = (setting: string, value: unknown): string => setting + ' = ' + JSON.stringify(value);
/** true = you allowed it, false = you said no (not asked again), null = not asked yet. */
export const allowedAnswer = (store: string, file: string, setting: string, value: unknown): boolean | null => {
  const answers = loadAllowed(store)[key(file)] ?? [];
  return answers.includes(allowKey(setting, value))
    ? true
    : answers.includes('no: ' + allowKey(setting, value))
      ? false
      : null;
};
export const saveAllowed = (store: string, file: string, setting: string, value: unknown, allow: boolean): void => {
  const all = loadAllowed(store);
  const entry = allowKey(setting, value);
  writeJson(store, {
    ...all,
    [key(file)]: _.union(_.without(all[key(file)] ?? [], entry, 'no: ' + entry), [(allow ? '' : 'no: ') + entry]),
  });
};

/** Answers for folders outside the project are kept with the others, one per folder (and read-only or not). */
export const OUTSIDE_FOLDER = 'folder outside the project';
export function outsideKey(m: { host: string; readOnly: boolean }): string {
  return (m.readOnly ? 'read-only ' : 'read/write ') + path.resolve(m.host).toLowerCase();
}
