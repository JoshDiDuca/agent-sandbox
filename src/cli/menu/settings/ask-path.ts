// Picking a folder or a file in the menu's path picker instead of typing it blind (which values are paths is the
// kernel's pathKindOf; this is only the menu's way of asking).
import type { PathKind } from '../../../app/kernel/index.js';
import type { App } from '../../tui/index.js';

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
