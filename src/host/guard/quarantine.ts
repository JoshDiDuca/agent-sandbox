import fs from 'node:fs';
import path from 'node:path';
import type { RepoFinding } from './repo-guard.js';

/** Moves files into <dir>\agent-sandbox-quarantine\<time>\ and reports them. */
export const quarantine = (from: string, names: string[], into: string, kind: RepoFinding['kind']): RepoFinding[] => {
  if (names.length === 0) return [];
  const target = path.join(into, 'agent-sandbox-quarantine', String(Date.now()));
  fs.mkdirSync(target, { recursive: true });
  return names.map((name) => {
    try {
      fs.renameSync(path.join(from, name), path.join(target, name));
    } catch (e) {
      return {
        kind,
        detail:
          name +
          ' (could not be moved: ' +
          (e as NodeJS.ErrnoException).code +
          '; delete it yourself before running anything here)',
      };
    }
    return { kind, detail: name + ' (moved to ' + target + ')' };
  });
};
