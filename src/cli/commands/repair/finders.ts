// Pure finders the repair checks use (exported for tests): they look, they never change anything.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { dirExists, fileExists, isLink } from '../../../core/util/index.js';

/**
 * Interrupted downloads and copies: `<name>.staging-<hex>` and `node-staging`, in tools\ and one folder down
 * (tools\go\1.23.staging-ab12).
 */
export function findStagingLeftovers(toolsDir: string): string[] {
  const isStaging = (name: string): boolean =>
    /\.staging-[0-9a-f]+$/i.test(name) || name.toLowerCase() === 'node-staging';
  const realChildren = (dir: string): string[] =>
    dirExists(dir) && !isLink(dir) ? fs.readdirSync(dir).map((n) => path.join(dir, n)) : [];
  return realChildren(toolsDir).flatMap((p) =>
    isStaging(path.basename(p)) ? [p] : isLink(p) ? [] : realChildren(p).filter((c) => isStaging(path.basename(c))),
  );
}

/**
 * A toolchain folder and the program it must contain. `versions` means one folder per installed version
 * (tools\go\1.23.2); `match` limits which version folders count (tools\nvm also holds settings and nvm.exe).
 */
export interface ToolRule {
  folder: string;
  exe: string[];
  versions?: boolean;
  match?: RegExp;
}

export const TOOL_RULES: ToolRule[] = [
  { folder: 'nvm', exe: ['nvm.exe'] },
  { folder: 'nvm', exe: ['node.exe'], versions: true, match: /^v\d+\.\d+\.\d+$/ },
  { folder: 'node', exe: ['node.exe'] },
  { folder: 'git', exe: ['bin', 'bash.exe'] },
  { folder: 'dotnet', exe: ['dotnet.exe'] },
  { folder: 'go', exe: ['bin', 'go.exe'], versions: true },
  { folder: 'java', exe: ['bin', 'java.exe'], versions: true },
  { folder: 'python', exe: ['python.exe'], versions: true },
];

/** Toolchain folders that exist but lack their main program (an install that stopped half way). Never enters links. */
export function findHalfInstalled(
  toolsDir: string,
  rules: ToolRule[] = TOOL_RULES,
): { path: string; missing: string }[] {
  const realDir = (p: string): boolean => dirExists(p) && !isLink(p);
  const staging = (name: string): boolean =>
    /\.staging-[0-9a-f]+$/i.test(name) || name.toLowerCase() === 'node-staging';
  return rules.flatMap((rule) => {
    const base = path.join(toolsDir, rule.folder);
    if (!realDir(base)) return [];
    const folders = rule.versions
      ? fs
          .readdirSync(base)
          .filter((n) => !staging(n) && (!rule.match || rule.match.test(n)))
          .map((n) => path.join(base, n))
          .filter(realDir)
      : [base];
    return folders
      .filter((f) => !fileExists(path.join(f, ...rule.exe)))
      .map((f) => ({ path: f, missing: path.join(...rule.exe) }));
  });
}

/**
 * Every link or junction under `root` (the links themselves; nothing behind them is visited). Before descending into
 * a folder its real path must still be inside root: a folder swapped for a junction between two looks is not followed.
 */
export function findLinks(root: string): string[] {
  if (isLink(root)) return [root];
  const real = (p: string): string => {
    try {
      return fs.realpathSync.native(p).toLowerCase();
    } catch {
      return '';
    }
  };
  const top = real(root);
  const inside = (p: string): boolean => {
    const r = real(p);
    return r !== '' && (r === top || r.startsWith(top + path.sep));
  };
  const walk = (dir: string): string[] => {
    if (!inside(dir)) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((d) => {
      const p = path.join(dir, d.name);
      if (d.isSymbolicLink() || isLink(p)) return [p];
      return d.isDirectory() ? walk(p) : [];
    });
  };
  return dirExists(root) ? walk(root) : [];
}

const ResolvedVersionsSchema = z.record(z.string(), z.unknown());
/** tools\resolved-versions.json is a JSON object (anything else makes the guest stumble). */
export function resolvedVersionsValid(text: string): boolean {
  try {
    return ResolvedVersionsSchema.safeParse(JSON.parse(text.replace(/^\uFEFF/, ''))).success;
  } catch {
    return false;
  }
}

const NpmListSchema = z.object({ dependencies: z.record(z.string(), z.unknown()).optional() });
/** Package names from `npm ls -g --json`; [] when the output is not what npm prints. */
export function globalPackages(json: string): string[] {
  try {
    return Object.keys(NpmListSchema.parse(JSON.parse(json)).dependencies ?? {});
  } catch {
    return [];
  }
}

const PidSchema = z.coerce.number().int().positive();
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
/** Sync-watcher pid files (storage\run\watcher-*.pid) whose process is gone (or whose content is not a pid). */
export function deadPidFiles(runDir: string, alive: (pid: number) => boolean = pidAlive): string[] {
  return (dirExists(runDir) ? fs.readdirSync(runDir) : [])
    .filter((n) => /^watcher-.*\.pid$/i.test(n))
    .map((n) => path.join(runDir, n))
    .filter((f) => {
      try {
        const pid = PidSchema.safeParse(fs.readFileSync(f, 'utf8').trim());
        return !pid.success || !alive(pid.data);
      } catch {
        return false;
      }
    });
}
