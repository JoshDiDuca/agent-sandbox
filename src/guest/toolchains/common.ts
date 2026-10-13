// Shared plumbing for the toolchain installers. Everything lives in C:\AgentData\tools (persistent), so only the first
// boot downloads; later boots only put things on PATH.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { download, githubAsset, installArchive, type ReleaseAsset } from '../../shared/download/index.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { errMsg, execOutput, exists, log, session, toolsDir, warn } from '../env.js';
import { projectWorkspace } from '../project-context.js';
import { MARKERS } from '../../core/detect/toolchains.js';
import { projectUses, specFromVersionFile } from '../../core/detect/versions.js';

/** What the toolchains contribute to the agent's environment. */
export interface ToolEnv {
  vars: Record<string, string>;
  prepend: string[];
  append: string[];
  summary: string[];
}
export const emptyEnv = (): ToolEnv => ({ vars: {}, prepend: [], append: [], summary: [] });

export const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
export const tool = (...parts: string[]): string => path.join(toolsDir, ...parts);

/** First x.y.z in a tool's `--version` output. */
export const versionOf = (exe: string, args: string[] = ['--version'], options = {}): string =>
  /\d+\.\d+\.\d+\S*/.exec(execOutput(exe, args, options))?.[0] ?? 'installed';

/** Small JSON state files in tools\: read with zod (a half-written file is just empty), written atomically. */
const readState = <S extends z.ZodType>(file: string, schema: S, empty: z.output<S>): z.output<S> => {
  try {
    return schema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))).data ?? empty;
  } catch {
    return empty;
  }
};

/** A remembered lookup; plain strings are what older versions wrote (treated as stale, still usable offline). */
const Resolved = z.record(z.string(), z.union([z.string(), z.strictObject({ value: z.string(), at: z.number() })]));
const resolvedFile = (): string => tool('resolved-versions.json');
const remembered = (): Record<string, { value: string; at: number }> =>
  Object.fromEntries(
    Object.entries(readState(resolvedFile(), Resolved, {})).map(([k, v]) => [
      k,
      typeof v === 'string' ? { value: v, at: 0 } : v,
    ]),
  );

/** How long a looked-up version is trusted: boots within a day make no version lookups at all. */
const FRESH_MS = 24 * 60 * 60 * 1000;
let offline = false;
const networkError = (e: unknown): boolean =>
  /fetch failed|timed? ?out|aborted|ENOTFOUND|EAI_AGAIN|ECONN|ENETUNREACH|EHOSTUNREACH|HTTP 5\d\d|socket/i.test(
    errMsg(e) + ' ' + String((e as { cause?: unknown })?.cause ?? ''),
  );

/**
 * Resolves a version online and remembers it for a day (provisioning.refresh looks again), so most boots make no
 * lookups and an offline boot reuses what was installed last time. After a network failure the remaining lookups go
 * straight to the remembered versions instead of each waiting for the network; other errors (no such version) do not.
 */
export const resolveCached = async (key: string, resolve: () => Promise<string>): Promise<string> => {
  const cached = remembered()[key];
  if (cached && (offline || (!session.provisioning.refresh && Date.now() - cached.at < FRESH_MS))) return cached.value;
  try {
    const value = await resolve();
    fs.mkdirSync(toolsDir, { recursive: true });
    writeJsonAtomic(resolvedFile(), { ...remembered(), [key]: { value, at: Date.now() } });
    return value;
  } catch (e) {
    if (networkError(e)) offline = true;
    if (!cached) throw e;
    warn(
      'Could not look up the latest ' +
        key +
        ' online (' +
        errMsg(e) +
        '); using ' +
        cached.value +
        ' from an earlier start.',
    );
    return cached.value;
  }
};

/** A single file download that lands as `file` only when complete (and checksum-verified): a cut-off one never looks finished. */
export const downloadFile = async (url: string, file: string, sha256: string | null = null): Promise<void> => {
  const part = file + '.part';
  try {
    await download(url, part, sha256);
    fs.rmSync(file, { force: true });
    fs.renameSync(part, file);
  } finally {
    fs.rmSync(part, { force: true });
  }
};

interface GithubInstall {
  /** The folder the archive is unpacked into (replaced atomically). */
  dest: string;
  /** What the progress line says is being downloaded, with its size; a function gets the release asset. */
  what: string | ((asset: ReleaseAsset) => string);
  /** Look past the latest release for a matching asset. */
  searchOlder?: boolean;
  /** installArchive's `locate` / `up`: keep only the folder holding this file. */
  locate?: string;
  up?: number;
}

/** The newest GitHub release asset matching `pattern`, checksum-verified, unpacked into `dest`. */
export const installFromGithub = async (repo: string, pattern: RegExp, o: GithubInstall): Promise<void> => {
  const asset = await githubAsset(repo, pattern, o.searchOlder);
  log('Downloading ' + (typeof o.what === 'string' ? o.what : o.what(asset)) + ' ...');
  await installArchive(asset.url, o.dest, {
    sha256: asset.sha256,
    fileName: asset.name,
    ...(o.locate ? { locate: o.locate } : {}),
    ...(o.up ? { up: o.up } : {}),
  });
};

/** Runs one installer; a failure is reported and skipped so it never blocks the other toolchains. */
export const step = async (name: string, env: ToolEnv, work: () => Promise<void>): Promise<void> => {
  try {
    await work();
  } catch (e) {
    warn(
      name +
        ' could not be set up and is skipped; everything else still works, and the next start tries again. Reason: ' +
        errMsg(e),
    );
    env.summary.push(name + ': FAILED');
  }
};

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

// ---- global packages, installed once -------------------------------------------------------------------------------

const installedFile = (): string => tool('installed-packages.json');
const installed = (): Record<string, string> => readState(installedFile(), z.record(z.string(), z.string()), {});

/**
 * Installs each package that is not installed yet (remembered in tools\installed-packages.json under `group`, e.g.
 * "npm@22.11.0"). One failing package is reported and skipped; it is tried again next boot.
 */
export const installOnce = async (
  env: ToolEnv,
  group: string,
  packages: string[],
  install: (pkg: string) => void | Promise<void>,
): Promise<void> => {
  const todo = packages.filter((p) => !installed()[group + ':' + p]);
  for (const pkg of todo) {
    try {
      log('Installing ' + pkg + ' (' + group + ') ...');
      await install(pkg);
      writeJsonAtomic(installedFile(), { ...installed(), [group + ':' + pkg]: new Date().toISOString() });
    } catch (e) {
      warn(
        pkg +
          ' (' +
          group +
          ') could not be installed and is skipped; the next start tries again. Reason: ' +
          errMsg(e),
      );
    }
  }
  const ok = packages.filter((p) => installed()[group + ':' + p]);
  if (ok.length) env.summary.push(group.split('@')[0] + ' packages: ' + ok.join(', '));
};
