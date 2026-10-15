// Is a managed install (versions side by side, a private Node, shims in bin) in one piece: do the two pointer files
// name installed folders, do the shims say what they should, is bin on PATH. These look; the fixes move a pointer or
// rewrite shims, and never delete a version.
import fs from 'node:fs';
import path from 'node:path';
import { expandVariables } from '../../core/util/index.js';
import { type InstallLayout, NODE_PATTERN, compareVersions, readBins, shimText } from '../install/index.js';

export interface PointerState {
  readonly activeVersion: string | null;
  readonly activeNode: string | null;
  /** Versions that have a package.json, oldest first. */
  readonly versions: readonly string[];
  /** Node folders that have node.exe, oldest first. */
  readonly nodes: readonly string[];
  readonly problems: readonly string[];
  /** Where the pointers should point to be whole again, or null when nothing usable is installed. */
  readonly want: { readonly version: string; readonly node: string } | null;
}

/** Node versions under <root>\node that really hold node.exe, oldest first. */
export function installedNodes(layout: InstallLayout): string[] {
  const dir = path.join(layout.root, 'node');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && NODE_PATTERN.test(d.name) && fs.existsSync(layout.nodeExe(d.name)))
      .map((d) => d.name)
      .sort((a, b) => compareVersions(a.slice(1), b.slice(1)));
  } catch {
    return [];
  }
}

/** Versions that are really there (a package.json in their package folder), oldest first. */
export function completeVersions(layout: InstallLayout): string[] {
  return layout.installedVersions().filter((v) => fs.existsSync(path.join(layout.packageDir(v), 'package.json')));
}

function rawPointer(layout: InstallLayout, name: string): string | null {
  try {
    return fs.readFileSync(path.join(layout.root, name), 'utf8').trim();
  } catch {
    return null;
  }
}

/** Looks at active-version and active-node. */
export function inspectPointers(layout: InstallLayout): PointerState {
  const versions = completeVersions(layout);
  const nodes = installedNodes(layout);
  const activeVersion = layout.activeVersion();
  const activeNode = layout.activeNode();
  const problems: string[] = [];
  const raw = (name: string): string => {
    const text = rawPointer(layout, name);
    return text === null ? 'is missing' : text === '' ? 'is empty' : 'says "' + text.slice(0, 40) + '"';
  };
  if (!activeVersion) problems.push('active-version ' + raw('active-version') + ' (it must name a version like 1.5.0)');
  else if (!versions.includes(activeVersion))
    problems.push('active-version points at ' + activeVersion + ', which is not installed');
  if (!activeNode) problems.push('active-node ' + raw('active-node') + ' (it must name a Node like v22.11.0)');
  else if (!nodes.includes(activeNode))
    problems.push('active-node points at ' + activeNode + ', which is not installed');
  const version = activeVersion && versions.includes(activeVersion) ? activeVersion : versions[versions.length - 1];
  const node = activeNode && nodes.includes(activeNode) ? activeNode : nodes[nodes.length - 1];
  return { activeVersion, activeNode, versions, nodes, problems, want: version && node ? { version, node } : null };
}

/** Moves the pointers to what is installed (the newest version and Node that are whole). Returns what changed. */
export function repairPointers(layout: InstallLayout, state: PointerState = inspectPointers(layout)): string {
  if (!state.want) throw new Error('No complete version or Node is installed in ' + layout.root + '.');
  layout.setActive(state.want.version, state.want.node);
  return 'active-version ' + state.want.version + ', active-node ' + state.want.node;
}

/** The commands a package folder declares (name -> program path), or null when its package.json cannot be read. */
export function binsOfPackage(packageDir: string): Record<string, string> | null {
  try {
    return readBins(JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')));
  } catch {
    return null;
  }
}

const sameText = (a: string, b: string): boolean => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

export interface ShimProblems {
  readonly missing: readonly string[];
  readonly different: readonly string[];
}

/** Shim files (both the .cmd and the shell one) that are missing or not what shimText() writes now. */
export function shimProblems(layout: InstallLayout, bins: Record<string, string>): ShimProblems {
  const missing: string[] = [];
  const different: string[] = [];
  for (const [name, target] of Object.entries(bins)) {
    for (const [file, kind] of [
      [name + '.cmd', 'cmd'],
      [name, 'sh'],
    ] as const) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(layout.binDir, file), 'utf8');
      } catch {
        missing.push(file);
        continue;
      }
      if (!sameText(text, shimText(name, kind, target))) different.push(file);
    }
  }
  return { missing, different };
}

const normal = (p: string): string =>
  path
    .normalize(expandVariables(p.trim().replace(/^"|"$/g, '')))
    .replace(/[\\/]+$/, '')
    .toLowerCase();

/** Is `dir` one of the entries of a PATH value (variables expanded, case and a trailing slash ignored)? */
export function pathHas(value: string | null, dir: string): boolean {
  if (!value) return false;
  const want = normal(dir);
  return value
    .split(';')
    .filter((p) => p.trim() !== '')
    .some((p) => normal(p) === want);
}
