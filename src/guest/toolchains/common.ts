// Shared plumbing for the toolchain installers. Everything lives in C:\AgentData\tools (persistent), so only the first
// boot downloads; later boots only put things on PATH.
import fs from 'node:fs';
import path from 'node:path';
import { errMsg, execOutput, exists, log, toolsDir, warn, workspace } from '../env.js';
import { projectUses, specFromVersionFile } from './versions.js';

/** What the toolchains contribute to the agent's environment. */
export interface ToolEnv { vars: Record<string, string>; prepend: string[]; append: string[]; summary: string[] }
export const emptyEnv = (): ToolEnv => ({ vars: {}, prepend: [], append: [], summary: [] });

export const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
export const tool = (...parts: string[]): string => path.join(toolsDir, ...parts);

/** First x.y.z in a tool's `--version` output. */
export const versionOf = (exe: string, args: string[] = ['--version'], options = {}): string => /\d+\.\d+\.\d+\S*/.exec(execOutput(exe, args, options))?.[0] ?? 'installed';

const resolvedFile = (): string => tool('resolved-versions.json');
const remembered = (): Record<string, string> => { try { return JSON.parse(fs.readFileSync(resolvedFile(), 'utf8')) as Record<string, string>; } catch { return {}; } };

let offline = false;

/**
 * Resolves a version online and remembers it, so an offline boot reuses what was installed last time. After one failed
 * lookup the rest go straight to the remembered versions instead of each waiting for the network.
 */
export const resolveCached = async (key: string, resolve: () => Promise<string>): Promise<string> => {
  const cached = remembered()[key];
  if (offline && cached) return cached;
  try {
    const value = await resolve();
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(resolvedFile(), JSON.stringify({ ...remembered(), [key]: value }, null, 2));
    return value;
  } catch (e) {
    offline = true;
    if (!cached) throw e;
    warn('Could not look up ' + key + ' online (' + errMsg(e) + '); using ' + cached + ' from the last boot.');
    return cached;
  }
};

/** Runs one installer; a failure is reported and skipped so it never blocks the other toolchains. */
export const step = async (name: string, env: ToolEnv, work: () => Promise<void>): Promise<void> => {
  try { await work(); } catch (e) { warn(name + ' setup failed (continuing without it): ' + errMsg(e)); env.summary.push(name + ': FAILED'); }
};

// ---- which toolchains a project needs ------------------------------------------------------------------------------

/** Files that show a project uses a language, for `enabled: "auto"` (looked for in the workspace and one folder down). */
export const MARKERS: Record<string, string[]> = {
  python: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile', 'uv.lock', 'poetry.lock', '.python-version'],
  rust: ['Cargo.toml', 'rust-toolchain', 'rust-toolchain.toml'],
  cpp: ['CMakeLists.txt', 'Makefile', 'meson.build', 'premake5.lua', 'Cargo.toml', '*.vcxproj'],
  dotnet: ['*.sln', '*.slnx', '*.csproj', '*.fsproj', '*.vbproj', 'global.json'],
  go: ['go.mod', 'go.work'],
  java: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'mvnw', 'gradlew', '.java-version', '.sdkmanrc'],
  ruby: ['Gemfile', '*.gemspec', '.ruby-version'],
  php: ['composer.json', 'artisan', '.php-version'],
  deno: ['deno.json', 'deno.jsonc', 'deno.lock'],
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'bin', 'obj', 'dist', 'build', 'vendor', '.venv', 'venv']);
let entries: string[] | null = null;

/** File names in the workspace and its direct sub-folders ("api/go.mod"); read once per boot. */
export const workspaceEntries = (): string[] => {
  if (entries) return entries;
  const list = (dir: string): fs.Dirent[] => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
  const top = list(workspace);
  const below = top.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name.toLowerCase()))
    .flatMap((d) => list(path.join(workspace, d.name)).filter((f) => f.isFile()).map((f) => d.name + '/' + f.name));
  entries = [...top.filter((d) => d.isFile()).map((d) => d.name), ...below];
  return entries;
};

/** true / false as configured; "auto" only when the workspace has one of the toolchain's marker files. */
export const wanted = (setting: boolean | 'auto', toolchain: string): boolean =>
  setting === 'auto' ? projectUses(workspaceEntries(), MARKERS[toolchain] ?? []) : setting;

/** The first of these version files in the workspace root, parsed (e.g. .ruby-version "3.3.1"). */
export const versionFromFiles = (files: string[], parse: (text: string, name: string) => string | null = (t) => specFromVersionFile(t)): { spec: string; source: string } | null => {
  for (const name of files) {
    const file = path.join(workspace, name);
    if (!exists(file)) continue;
    const spec = parse(fs.readFileSync(file, 'utf8'), name);
    if (spec) return { spec, source: name };
  }
  return null;
};

// ---- global packages, installed once -------------------------------------------------------------------------------

const installedFile = (): string => tool('installed-packages.json');
const installed = (): Record<string, string> => { try { return JSON.parse(fs.readFileSync(installedFile(), 'utf8')) as Record<string, string>; } catch { return {}; } };

/**
 * Installs each package that is not installed yet (remembered in tools\installed-packages.json under `group`, e.g.
 * "npm@22.11.0"). One failing package is reported and skipped; it is tried again next boot.
 */
export const installOnce = async (env: ToolEnv, group: string, packages: string[], install: (pkg: string) => void | Promise<void>): Promise<void> => {
  const todo = packages.filter((p) => !installed()[group + ':' + p]);
  for (const pkg of todo) {
    try {
      log('Installing ' + pkg + ' (' + group + ') ...');
      await install(pkg);
      fs.writeFileSync(installedFile(), JSON.stringify({ ...installed(), [group + ':' + pkg]: new Date().toISOString() }, null, 2));
    } catch (e) { warn(group + ' package ' + pkg + ' failed: ' + errMsg(e)); }
  }
  const ok = packages.filter((p) => installed()[group + ':' + p]);
  if (ok.length) env.summary.push(group.split('@')[0] + ' packages: ' + ok.join(', '));
};
