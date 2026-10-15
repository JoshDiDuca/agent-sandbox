// The one place that decides which folders are on the machine PATH, in what order, and how a process's PATH is brought
// up to date with the registry. Pure (no side effects): the self-test imports this file. The shells' own start-up code
// (sandbox\csharp\PathSync.cs) follows the same rules.
import path from 'node:path';

/** A folder as a comparison key: one slash style, no trailing slash (a drive root keeps its one), lower case. */
export function pathKey(folder: string): string {
  const slashes = folder.trim().replace(/^"|"$/g, '').replace(/\//g, '\\');
  return (slashes.length > 3 ? slashes.replace(/\\+$/, '') : slashes).toLowerCase();
}

/** The folders of a PATH string: no empty parts, no quotes around a folder. */
export function splitPath(value: string): string[] {
  return value
    .split(';')
    .map((part) => part.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/** Replaces %NAME% with the variable's value (any case); a name that is not set stays as written. */
export function expandVars(value: string, env: Readonly<Record<string, string | undefined>>): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%;\\]+)%/g, (whole, name: string) => lower.get(name.toLowerCase()) ?? whole);
}

export interface PathPlanInput {
  /** In the order they should have: earlier entries win. */
  readonly entries: readonly string[];
  readonly exists: (folder: string) => boolean;
  /** Entries to leave out (a folder that must not be machine-wide, matched like pathKey). */
  readonly drop?: (folder: string) => boolean;
}

/** Ordered, de-duplicated (case, trailing slash) PATH folders; missing and dropped folders are left out. */
export function planPath(input: PathPlanInput): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of input.entries.flatMap(splitPath)) {
    const key = pathKey(entry);
    if (seen.has(key) || input.drop?.(entry) || !input.exists(entry)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

/** `base` with the folders of `extra` it lacks added at the end (a process keeps its own order and entries). */
export function appendMissing(base: string, extra: string, skip: (folder: string) => boolean = () => false): string {
  const seen = new Set(splitPath(base).map(pathKey));
  const added = splitPath(extra).filter((folder) => {
    const key = pathKey(folder);
    if (seen.has(key) || skip(folder)) return false;
    seen.add(key);
    return true;
  });
  return [...splitPath(base), ...added].join(';');
}

/**
 * What a new shell gets: folders only this process has first (a parent put them there on purpose), then the machine
 * and the user PATH with their %VARIABLES% expanded; no duplicates. `skip` leaves folders out (the runner's own Node).
 */
export function rebuildPath(o: {
  readonly machine: string;
  readonly user: string;
  readonly process: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly skip?: (folder: string) => boolean;
}): string {
  const registry = splitPath(expandVars(o.machine, o.env) + ';' + expandVars(o.user, o.env));
  const known = new Set(registry.map(pathKey));
  const only = splitPath(o.process).filter((f) => !known.has(pathKey(f)) && !o.skip?.(f));
  return planPath({ entries: [...only, ...registry], exists: () => true }).join(';');
}

/** The value of `Path` in the output of `reg query <key> /v Path` ('' when there is none). */
export function parseRegPath(output: string): string {
  const line = output.split(/\r?\n/).find((l) => /^\s+Path\s+REG_(EXPAND_)?SZ\s/i.test(l));
  return line ? line.replace(/^\s+Path\s+REG_(EXPAND_)?SZ\s+/i, '').trim() : '';
}

/** A folder of one pinned Node version (nvm's `v24.22.0`): never machine-wide, `nvm use` would not move it. */
export function isPinnedNodeDir(folder: string, nvmHome: string): boolean {
  const key = pathKey(folder);
  const home = pathKey(nvmHome);
  return key.startsWith(home + '\\') && /^v\d/.test(path.win32.basename(key));
}
