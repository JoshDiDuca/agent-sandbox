// Which settings hold a folder or a file on this PC, so they are picked in the path picker instead of typed blind.
import type { App } from '../../tui/index.js';
import type { SchemaNode } from './schema-node.js';

/** A folder or a file. */
export type PathKind = 'dir' | 'file';

/** Top-level settings whose list entries are folders or files, and the single settings that are one. */
const KINDS: Readonly<Record<string, PathKind>> = {
  'storage.root': 'dir',
  'projects.roots': 'dir',
  'projects.exclude': 'dir',
  'projects.declinedRoots': 'dir',
  'claudeProfile.hostDir': 'dir',
  'claudeProfile.globalStateFile': 'file',
  scripts: 'file',
};

/** The kind of path a setting holds (its key without list positions), or undefined when it is not a path. */
export function pathKindOf(key: readonly string[]): PathKind | undefined {
  const id = key.join('.');
  const last = key[key.length - 1] ?? '';
  if (KINDS[id]) return KINDS[id];
  if (key[0] === 'mappings' && last === 'host') return 'dir';
  if (last === 'hostDir') return 'dir';
  if (/(Dir|Folder)$/.test(last)) return 'dir';
  if (/File$/.test(last)) return 'file';
  return undefined;
}

/** Words that are fine instead of a path ("auto"), read from the setting's description. */
export function pathLiterals(node: SchemaNode): string[] {
  return /"auto"/.test(node.description ?? '') ? ['auto'] : [];
}

export interface AskPathOptions {
  readonly path: string[];
  readonly title: string;
  readonly about?: string[];
  readonly kind: PathKind;
  readonly initial?: string;
  readonly literals?: readonly string[];
  /** true = fine, a string = what is wrong (shown under the path). */
  readonly validate?: (path: string) => true | string;
}

/** Picks a folder or file in the path picker; typing a path (or an allowed word) still works. */
export function askPath(app: App, o: AskPathOptions): Promise<string | undefined> {
  return app.pickPath({
    path: o.path,
    title: o.title,
    about: o.about,
    initial: o.initial,
    files: o.kind === 'file',
    use: o.kind === 'file' ? 'use this file' : 'use this folder',
    literals: o.literals,
    relative: true,
    validate: o.validate,
  });
}
