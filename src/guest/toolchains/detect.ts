import fs from 'node:fs';
import path from 'node:path';
import { exists } from '../runtime/fs.js';
import { projectWorkspace } from '../runtime/project-context.js';
import { MARKERS } from '../../core/detect/toolchains.js';
import { projectUses, specFromVersionFile } from '../../core/detect/versions.js';

// ---- which toolchains a project needs ------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'bin', 'obj', 'dist', 'build', 'vendor', '.venv', 'venv']);
const entries = new Map<string, string[]>();

/** File names in the project's folder and its direct sub-folders ("api/go.mod"); read once per project. */
export const workspaceEntries = (): string[] => {
  const workspace = projectWorkspace();
  const known = entries.get(workspace.toLowerCase());
  if (known) return known;
  const list = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const top = list(workspace);
  const below = top
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name.toLowerCase()))
    .flatMap((d) =>
      list(path.join(workspace, d.name))
        .filter((f) => f.isFile())
        .map((f) => d.name + '/' + f.name),
    );
  const found = [...top.filter((d) => d.isFile()).map((d) => d.name), ...below];
  entries.set(workspace.toLowerCase(), found);
  return found;
};

/**
 * true / false as configured. The host already turns "auto" into a decision at launch (core/detect-toolchains.ts);
 * this only applies when a session file still says "auto": the workspace has one of the marker files.
 */
export const wanted = (setting: boolean | 'auto', toolchain: string): boolean =>
  setting === 'auto'
    ? projectUses(workspaceEntries(), (MARKERS as Record<string, readonly string[]>)[toolchain] ?? [])
    : setting;

/** The first of these version files in the workspace root, parsed (e.g. .ruby-version "3.3.1"). */
export const versionFromFiles = (
  files: string[],
  parse: (text: string, name: string) => string | null = (t) => specFromVersionFile(t),
): { spec: string; source: string } | null => {
  for (const name of files) {
    const file = path.join(projectWorkspace(), name);
    if (!exists(file)) continue;
    const spec = parse(fs.readFileSync(file, 'utf8'), name);
    if (spec) return { spec, source: name };
  }
  return null;
};
