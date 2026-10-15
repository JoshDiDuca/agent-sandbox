// The two scopes Settings and Apps edit: your own file ("All projects", blue) and this folder's .sandbox-config.json
// ("This project", purple).
import { Text, Theme, type Tab } from '../../tui/index.js';
import type { ConfigFile } from '../../../app/features/settings/index.js';

export type Scope = 'user' | 'project';

export const SCOPES: { scope: Scope; tab: Tab }[] = [
  { scope: 'user', tab: { label: 'All projects', badge: 'YOURS', paint: Theme.scopeGlobal } },
  { scope: 'project', tab: { label: 'This project', badge: 'PROJECT', paint: Theme.scopeProject } },
];

/** The line under the tabs: which file is being edited. */
export function scopeStatus(file: ConfigFile): string {
  return (
    (file.isProject ? Theme.project('●') : Theme.accent('●')) +
    Theme.muted(' Editing ') +
    Text.middle(file.file, 80) +
    (file.exists ? '' : Theme.muted(' (created when you save)')) +
    (file.isProject ? Theme.muted('  · only what a project may set; needs your approval at the next launch') : '')
  );
}
