// The managed install layout: versions side by side under <root>\versions, a private Node under <root>\node, shims in
// <root>\bin, and two one-line pointer files (active-version, active-node) that the shims read. Switching the pointers
// is the only thing an update changes in place, so a version can be checked before it is used and put back after.
import fs from 'node:fs';
import path from 'node:path';
import { fail } from '../../core/util/index.js';
import { writeFileAtomic } from '../../shared/io/index.js';

export type InstallScope = 'user' | 'machine';

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const NODE_PATTERN = /^v\d+\.\d+\.\d+$/;

/** Numeric x.y.z order: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const readPointer = (file: string, pattern: RegExp): string | null => {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return pattern.test(value) ? value : null;
  } catch {
    return null;
  }
};

const isUnder = (child: string, parent: string): boolean => {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
};

export class InstallLayout {
  private constructor(
    readonly root: string,
    readonly scope: InstallScope,
  ) {}

  static at(root: string, scope: InstallScope): InstallLayout {
    if (!path.isAbsolute(root)) fail('The install folder must be an absolute path: ' + root);
    return new InstallLayout(path.resolve(root), scope);
  }

  /**
   * The layout a package runs from, when that package is a managed install: <root>\versions\<x.y.z>\package. Anything
   * else (an npm global, a git checkout) is not managed and gives null.
   */
  static detect(packageRoot: string): InstallLayout | null {
    const resolved = path.resolve(packageRoot);
    const version = path.dirname(resolved);
    const versions = path.dirname(version);
    if (path.basename(resolved) !== 'package') return null;
    if (!VERSION_PATTERN.test(path.basename(version))) return null;
    if (path.basename(versions).toLowerCase() !== 'versions') return null;
    const root = path.dirname(versions);
    const programFiles = process.env.ProgramFiles;
    const machine = !!programFiles && isUnder(root, programFiles);
    return new InstallLayout(root, machine ? 'machine' : 'user');
  }

  get binDir(): string {
    return path.join(this.root, 'bin');
  }

  get versionsDir(): string {
    return path.join(this.root, 'versions');
  }

  versionDir(version: string): string {
    if (!VERSION_PATTERN.test(version)) fail('"' + version + '" is not a version number (x.y.z).');
    return path.join(this.versionsDir, version);
  }

  nodeDir(nodeVersion: string): string {
    if (!NODE_PATTERN.test(nodeVersion)) fail('"' + nodeVersion + '" is not a Node version (vx.y.z).');
    return path.join(this.root, 'node', nodeVersion);
  }

  nodeExe(nodeVersion: string): string {
    return path.join(this.nodeDir(nodeVersion), 'node.exe');
  }

  /** The package folder of an installed version (it holds package.json and dist/). */
  packageDir(version: string): string {
    return path.join(this.versionDir(version), 'package');
  }

  activeVersion(): string | null {
    return readPointer(path.join(this.root, 'active-version'), VERSION_PATTERN);
  }

  activeNode(): string | null {
    return readPointer(path.join(this.root, 'active-node'), NODE_PATTERN);
  }

  /** Points the shims at `version` and `nodeVersion`. Both must be installed; each file is written atomically. */
  setActive(version: string, nodeVersion: string): void {
    if (!fs.existsSync(path.join(this.packageDir(version), 'package.json')))
      fail('Version ' + version + ' is not installed in ' + this.root + '.');
    if (!fs.existsSync(this.nodeExe(nodeVersion)))
      fail('Node ' + nodeVersion + ' is not installed in ' + this.root + '.');
    writeFileAtomic(path.join(this.root, 'active-node'), nodeVersion + '\n');
    writeFileAtomic(path.join(this.root, 'active-version'), version + '\n');
  }

  /** Installed versions (folders named x.y.z under versions\), oldest first. Staging folders are ignored. */
  installedVersions(): string[] {
    if (!fs.existsSync(this.versionsDir)) return [];
    return fs
      .readdirSync(this.versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && VERSION_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersions);
  }
}
