// VS Code for debugging inside the sandbox: the portable zip build, checksum-verified. A `data` folder next to Code.exe
// switches it to portable mode, so settings and extensions live in C:\AgentData\tools\vscode\data and persist.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import type { Toolchains } from '../../core/types.js';
import { fetchJson, installArchive } from '../../shared/download/index.js';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, exists, isWin, log, logsDir, mkdirp, powershell } from '../env.js';
import { arch, tool, type ToolEnv } from './common.js';
import { EXTENSION_ID, missingExtensions, vscodeExtensions, vscodeSettings } from './vscode-profile.js';

interface Release {
  url: string;
  sha256hash: string;
  productVersion: string;
}

/** Newer builds keep their files under a commit-hash folder, so the installed version is recorded here. */
const VERSION_MARKER = '.agent-sandbox-version';

const desktopShortcut = (exe: string): void => {
  if (!isWin) return;
  const link = path.join(os.homedir(), 'Desktop', 'Visual Studio Code.lnk');
  const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
  powershell(
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' +
      q(link) +
      '); $s.TargetPath = ' +
      q(exe) +
      '; $s.Arguments = ' +
      q('"' + (process.env.AGENT_WORKSPACE ?? '') + '"') +
      '; $s.Save()',
  );
};

/** The first of `names` in one of `dirs`. */
const findIn = (dirs: string[], ...names: string[]): string | undefined => {
  for (const dir of dirs)
    for (const name of names) {
      const file = path.join(dir, name);
      if (exists(file)) return file;
    }
  return undefined;
};

/** The project's .vscode/extensions.json recommendations (bounded; anything odd is ignored). */
const recommendedBy = (workspace: string): string[] => {
  const file = path.join(workspace, '.vscode', 'extensions.json');
  try {
    if (!exists(file) || fs.statSync(file).size > 64 * 1024) return [];
    const data = parseJsonc(fs.readFileSync(file, 'utf8')) as { recommendations?: unknown } | undefined;
    return Array.isArray(data?.recommendations)
      ? data.recommendations.filter((r): r is string => typeof r === 'string' && EXTENSION_ID.test(r)).slice(0, 50)
      : [];
  } catch {
    return [];
  }
};

/**
 * After every toolchain is installed: points VS Code at the sandbox's own JDK, Python, Go, compilers, .NET, Git and
 * terminals (user settings; only the keys this tool manages are changed, your own stay), and installs the extensions
 * for the languages in use in the background (they persist, so only new ones are downloaded).
 */
export const configureVscode = (
  tools: { vars: Record<string, string>; prepend: string[]; append: string[]; summary: string[] },
  o: { toolchains: string[]; databases: string[]; config: Toolchains['vscode']; workspace: string },
): void => {
  const root = tool('vscode');
  const code = path.join(root, 'bin', 'code.cmd');
  if (dryRun) {
    log('(dry run) would set up VS Code for: ' + o.toolchains.join(', '));
    return;
  }
  if (!exists(path.join(root, 'Code.exe'))) return;
  const dirs = [...tools.prepend, ...tools.append];
  const git = findIn([tool('git', 'cmd'), ...dirs], 'git.exe');
  const settings = vscodeSettings({
    javaHome: tools.vars.JAVA_HOME,
    goRoot: tools.vars.GOROOT,
    go: findIn(dirs, 'go.exe'),
    python: findIn(dirs, 'python.exe'),
    gcc: findIn(dirs, 'gcc.exe'),
    cl: findIn(dirs, 'cl.exe'),
    cmake: findIn(dirs, 'cmake.exe'),
    dotnet: findIn(dirs, 'dotnet.exe'),
    node: findIn(dirs, 'node.exe'),
    pwsh: findIn(dirs, 'pwsh.exe'),
    git,
    bash: git ? findIn([path.join(path.dirname(path.dirname(git)), 'bin')], 'bash.exe') : undefined,
    php: findIn(dirs, 'php.exe'),
    ruby: findIn(dirs, 'ruby.exe'),
    deno: findIn(dirs, 'deno.exe'),
  });
  writeManagedSettings(
    path.join(root, 'data', 'user-data', 'User', 'settings.json'),
    path.join(root, 'data', '.agent-sandbox-managed.json'),
    settings,
  );

  const wanted = vscodeExtensions({
    toolchains: o.toolchains,
    databases: o.databases,
    recommended: o.config.recommended ? recommendedBy(o.workspace) : [],
    extra: o.config.extensions,
  });
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(path.join(root, 'data', 'extensions'));
  } catch {
    /* none yet */
  }
  const missing = missingExtensions(wanted, folders);
  tools.summary.push(
    'vscode: set up for ' +
      (o.toolchains.join(', ') || 'Node') +
      (missing.length ? '; installing ' + missing.length + ' extension(s) in the background' : '; extensions ready'),
  );
  if (!missing.length) return;
  // In the background: the Marketplace can take a minute, and nothing else waits for it.
  const logFile = fs.openSync(path.join(logsDir, 'vscode-extensions.log'), 'a');
  spawn(SYSTEM.cmd(), ['/d', '/c', code, ...missing.flatMap((id) => ['--install-extension', id])], {
    detached: true,
    stdio: ['ignore', logFile, logFile],
    windowsHide: true,
  }).unref();
  fs.closeSync(logFile);
};

/**
 * Sets `values` in a settings file, keeping everything else (comments too), and removes keys this tool set last time
 * but no longer has a value for (a toolchain turned off). The keys it manages are remembered in `managedFile`.
 */
const writeManagedSettings = (file: string, managedFile: string, values: Record<string, unknown>): void => {
  let text = exists(file) ? fs.readFileSync(file, 'utf8') : '{}';
  let before: string[] = [];
  try {
    before = JSON.parse(fs.readFileSync(managedFile, 'utf8')) as string[];
  } catch {
    /* first time */
  }
  const format = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
  for (const key of before.filter((k) => !(k in values))) {
    if ((parseJsonc(text) as Record<string, unknown> | undefined)?.[key] !== undefined)
      text = applyEdits(text, modify(text, [key], undefined, format));
  }
  for (const [key, value] of Object.entries(values)) text = applyEdits(text, modify(text, [key], value, format));
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, text);
  fs.writeFileSync(managedFile, JSON.stringify(Object.keys(values)));
};

export const setupVscode = async (env: ToolEnv, refresh: boolean): Promise<void> => {
  const root = tool('vscode');
  const exe = path.join(root, 'Code.exe');
  if (dryRun) {
    log('(dry run) would provision VS Code');
    return;
  }
  if (!exists(exe) || refresh) {
    const release = await fetchJson<Release>(
      'https://update.code.visualstudio.com/api/update/win32-' +
        (arch === 'arm64' ? 'arm64' : 'x64') +
        '-archive/stable/latest',
    );
    log('Downloading VS Code ' + release.productVersion + ' (~150 MB once) ...');
    // Keep settings/extensions across a refresh: move the portable data folder aside and back, also when the install
    // fails (finally). A folder still parked from an interrupted earlier run is the one to keep.
    const keep = path.join(root, 'data');
    const parked = root + '-data';
    if (exists(keep)) {
      fs.rmSync(parked, { recursive: true, force: true });
      fs.renameSync(keep, parked);
    }
    try {
      await installArchive(release.url, root, {
        sha256: release.sha256hash,
        locate: 'Code.exe',
        fileName: 'vscode.zip',
      });
      fs.writeFileSync(path.join(root, VERSION_MARKER), release.productVersion);
    } finally {
      if (exists(parked)) {
        mkdirp(root);
        fs.rmSync(keep, { recursive: true, force: true });
        fs.renameSync(parked, keep);
      }
    }
  }
  mkdirp(path.join(root, 'data'));
  env.prepend.push(path.join(root, 'bin'));
  desktopShortcut(exe);
  const version = exists(path.join(root, VERSION_MARKER))
    ? fs.readFileSync(path.join(root, VERSION_MARKER), 'utf8').trim()
    : 'installed';
  env.summary.push('vscode: ' + version + ' (portable; run code . or use the desktop shortcut)');
};
