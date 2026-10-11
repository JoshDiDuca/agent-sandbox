// Developer toolchains inside the sandbox. Everything lives in C:\AgentData\tools (persistent), so only the first
// boot downloads; later boots only put things on PATH. Each installer is independent: one failing never blocks the rest.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Toolchains, ToolVersions } from '../core/types.js';
import { download, fetchJson, githubAsset, installArchive } from '../shared/download.js';
import { dryRun, errMsg, exec, execOutput, exists, hostToolsDir, localDir, log, mkdirp, robocopy, setSandboxStatus, toolsDir, warn, workspace } from './env.js';

/** What the toolchains contribute to the agent's environment. */
export interface ToolEnv { vars: Record<string, string>; prepend: string[]; append: string[]; summary: string[] }
const emptyEnv = (): ToolEnv => ({ vars: {}, prepend: [], append: [], summary: [] });

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const tool = (...parts: string[]): string => path.join(toolsDir, ...parts);

/** Remembers resolved versions so offline boots reuse what was installed last time. */
const resolvedFile = tool('resolved-versions.json');
const remembered = (): Record<string, string> => { try { return JSON.parse(fs.readFileSync(resolvedFile, 'utf8')) as Record<string, string>; } catch { return {}; } };
const resolveCached = async (key: string, resolve: () => Promise<string>): Promise<string> => {
  try {
    const value = await resolve();
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(resolvedFile, JSON.stringify({ ...remembered(), [key]: value }, null, 2));
    return value;
  } catch (e) {
    const cached = remembered()[key];
    if (cached) { warn('Could not look up ' + key + ' online (' + errMsg(e) + '); using ' + cached + ' from the last boot.'); return cached; }
    throw e;
  }
};

const step = async (name: string, env: ToolEnv, work: () => Promise<void>): Promise<void> => {
  setSandboxStatus('provisioning', 'Setting up ' + name);
  try { await work(); } catch (e) { warn(name + ' setup failed (continuing without it): ' + errMsg(e)); env.summary.push(name + ': FAILED'); }
};

// ---- Git for Windows (full, with bash: Claude Code on Windows needs Git Bash) ----------------------------------

export const setupGit = async (env: ToolEnv, hostCopy: boolean, refresh: boolean): Promise<void> => {
  const root = tool('git');
  const bash = path.join(root, 'bin', 'bash.exe');
  if (exists(root) && !exists(bash)) { log('Replacing the old MinGit (no bash) with full Git for Windows.'); fs.rmSync(root, { recursive: true, force: true }); }
  if (!exists(bash) || refresh) {
    if (dryRun) { log('(dry run) would provision Git for Windows' + (hostCopy ? ' from this PC' : '')); return; }
    if (hostCopy && exists(path.join(hostToolsDir, 'git', 'bin', 'bash.exe'))) { log('Copying Git for Windows from this PC ...'); robocopy(path.join(hostToolsDir, 'git'), root); }
    else {
      const asset = await githubAsset('git-for-windows/git', arch === 'arm64' ? /^PortableGit-[\d.]+-arm64\.7z\.exe$/ : /^PortableGit-[\d.]+-64-bit\.7z\.exe$/);
      const sfx = tool(asset.name);
      log('Downloading ' + asset.name + ' ...');
      await download(asset.url, sfx, asset.sha256);
      exec(sfx, ['-o' + root, '-y'], { stdio: 'ignore' });
      fs.rmSync(sfx, { force: true });
    }
  }
  if (!exists(bash)) throw new Error('bash.exe missing after installing Git');
  env.prepend.push(path.join(root, 'cmd'));
  env.append.push(path.join(root, 'usr', 'bin'));
  env.vars.CLAUDE_CODE_GIT_BASH_PATH = bash;
  env.summary.push('git: ' + execOutput(path.join(root, 'cmd', 'git.exe'), ['--version']).replace(/^git version /, ''));
};

// ---- Node through nvm-windows ---------------------------------------------------------------------------------

interface NodeRelease { version: string; lts: string | false }

const NVM_HOME = tool('nvm');
const NVM_SYMLINK = path.join(localDir, 'nodejs');

/** Turns an .nvmrc-style spec (20, v20.11.1, lts/*, lts/iron, node, latest) into an exact version like 20.11.1. */
export const pickNodeVersion = (releases: NodeRelease[], spec: string): string | null => {
  const s = spec.trim().toLowerCase().replace(/^v/, '');
  const hit = ['node', 'latest', 'current', 'stable'].includes(s) ? releases[0]
    : s === 'lts' || s === 'lts/*' ? releases.find((r) => r.lts)
    : s.startsWith('lts/') ? releases.find((r) => typeof r.lts === 'string' && r.lts.toLowerCase() === s.slice(4))
    : releases.find((r) => r.version === 'v' + s || r.version.startsWith('v' + s + '.'));
  return hit ? hit.version.slice(1) : null;
};

const resolveNode = (spec: string): Promise<string> => resolveCached('node:' + spec, async () => {
  if (/^\d+\.\d+\.\d+$/.test(spec.replace(/^v/, ''))) return spec.replace(/^v/, '');
  const releases = await fetchJson<NodeRelease[]>('https://nodejs.org/dist/index.json');
  return pickNodeVersion(releases, spec) ?? Promise.reject(new Error('No Node.js release matches "' + spec + '"'));
});

const nvm = (args: string[]): string => {
  const result = spawnSync(path.join(NVM_HOME, 'nvm.exe'), args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, NVM_HOME, NVM_SYMLINK } });
  return (result.stdout ?? '') + (result.stderr ?? '');
};

const installNodeVersion = (version: string): void => {
  const dir = path.join(NVM_HOME, 'v' + version);
  if (exists(path.join(dir, 'node.exe'))) return;
  const fromHost = path.join(hostToolsDir, 'nvm', 'v' + version);
  if (exists(path.join(fromHost, 'node.exe'))) { log('Copying Node ' + version + ' from this PC\'s nvm ...'); robocopy(fromHost, dir); return; }
  log('nvm install ' + version + ' ...');
  const out = nvm(['install', version]);
  if (!exists(path.join(dir, 'node.exe'))) throw new Error('nvm install ' + version + ' failed: ' + out.trim().split('\n').slice(-2).join(' '));
};

export const setupNode = async (env: ToolEnv, versions: ToolVersions): Promise<void> => {
  if (dryRun) { log('(dry run) would provision nvm and Node ' + versions.node.spec + ' (from ' + versions.node.source + ')'); return; }
  if (!exists(path.join(NVM_HOME, 'nvm.exe'))) {
    const hostNvm = path.join(hostToolsDir, 'nvm');
    if (exists(path.join(hostNvm, 'nvm.exe'))) {
      log('Copying nvm from this PC ...');
      mkdirp(NVM_HOME);
      for (const file of fs.readdirSync(hostNvm).filter((f) => /\.(exe|cmd|vbs)$/i.test(f))) fs.copyFileSync(path.join(hostNvm, file), path.join(NVM_HOME, file));
    } else {
      // nvm-windows 2.x only ships installers; the portable build is the newest 1.x release that has nvm-noinstall.zip.
      const asset = await githubAsset('coreybutler/nvm-windows', /^nvm-noinstall\.zip$/, true);
      log('Downloading nvm-windows (' + asset.url.split('/').slice(-2, -1)[0] + ') ...');
      await installArchive(asset.url, NVM_HOME, { sha256: asset.sha256, locate: 'nvm.exe', fileName: asset.name });
    }
  }
  fs.writeFileSync(path.join(NVM_HOME, 'settings.txt'), ['root: ' + NVM_HOME, 'path: ' + NVM_SYMLINK, 'arch: ' + (arch === 'arm64' ? 'arm64' : '64'), 'proxy: none', ''].join('\r\n'));
  mkdirp(localDir);

  const main = await resolveNode(versions.node.spec);
  for (const extra of versions.nodeExtra) { try { installNodeVersion(await resolveNode(extra)); } catch (e) { warn('Extra Node ' + extra + ': ' + errMsg(e)); } }
  installNodeVersion(main);
  nvm(['use', main]);
  if (!exists(path.join(NVM_SYMLINK, 'node.exe'))) {
    fs.rmSync(NVM_SYMLINK, { recursive: true, force: true });
    fs.symlinkSync(path.join(NVM_HOME, 'v' + main), NVM_SYMLINK, 'junction');
  }
  Object.assign(env.vars, { NVM_HOME, NVM_SYMLINK });
  env.prepend.push(NVM_HOME, NVM_SYMLINK);
  env.summary.push('node: ' + main + ' (from ' + versions.node.source + ', switch with nvm use)');
};

// ---- Python 3 / Python 2 (full CPython from the official NuGet packages, with pip) -----------------------------

const pickPackageVersion = (all: string[], spec: string): string | null => {
  const s = spec.trim().replace(/^python-?/i, '');
  const stable = all.filter((v) => /^\d+(\.\d+)*$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return stable.find((v) => v === s || v.startsWith(s + '.')) ?? null;
};

const installPython = async (pkg: 'python' | 'python2', spec: string): Promise<string> => {
  const version = await resolveCached(pkg + ':' + spec, async () => {
    const { versions } = await fetchJson<{ versions: string[] }>('https://api.nuget.org/v3-flatcontainer/' + pkg + '/index.json');
    return pickPackageVersion(versions, spec) ?? Promise.reject(new Error('No ' + pkg + ' release matches "' + spec + '"'));
  });
  const dir = tool('python', pkg + '-' + version);
  const exe = path.join(dir, 'python.exe');
  if (!exists(exe)) {
    log('Downloading ' + pkg + ' ' + version + ' ...');
    await installArchive('https://api.nuget.org/v3-flatcontainer/' + pkg + '/' + version + '/' + pkg + '.' + version + '.nupkg', dir, { locate: 'python.exe', fileName: pkg + '.' + version + '.zip' });
  }
  if (!exists(path.join(dir, 'Scripts', 'pip.exe')) && !exists(path.join(dir, 'Scripts', 'pip2.exe'))) exec(exe, ['-m', 'ensurepip', '--default-pip'], { stdio: 'ignore' });
  return dir;
};

const writeShim = (name: string, command: string): void => {
  fs.writeFileSync(path.join(mkdirp(tool('shims')), name + '.cmd'), '@echo off\r\n' + command + ' %*\r\n');
};

export const setupPython = async (env: ToolEnv, config: Toolchains['python'], versions: ToolVersions): Promise<void> => {
  if (dryRun) { log('(dry run) would provision Python ' + versions.python.spec + (config.python2 ? ' and Python 2.7' : '')); return; }
  const py3 = await installPython('python', versions.python.spec);
  writeShim('python3', '"' + path.join(py3, 'python.exe') + '"');
  writeShim('pip3', '"' + path.join(py3, 'python.exe') + '" -m pip');
  env.prepend.push(py3, path.join(py3, 'Scripts'), tool('shims'));
  env.vars.PYTHONIOENCODING = 'utf-8';
  env.summary.push('python: ' + path.basename(py3).replace('python-', '') + ' (from ' + versions.python.source + ')');
  if (config.python2) {
    const py2 = await installPython('python2', '2.7');
    writeShim('python2', '"' + path.join(py2, 'python.exe') + '"');
    writeShim('pip2', '"' + path.join(py2, 'python.exe') + '" -m pip');
    env.summary.push('python2: ' + path.basename(py2).replace('python2-', ''));
  }
};

// ---- C / C++ (MinGW-w64 GCC from WinLibs) -----------------------------------------------------------------------

export const setupCpp = async (env: ToolEnv): Promise<void> => {
  const bin = tool('mingw', 'mingw64', 'bin');
  const gcc = path.join(bin, 'gcc.exe');
  if (dryRun) { log('(dry run) would provision MinGW-w64 GCC'); return; }
  if (!exists(gcc)) {
    const asset = await githubAsset('brechtsanders/winlibs_mingw', arch === 'arm64' ? /^winlibs-aarch64-.*\.zip$/ : /^winlibs-x86_64-posix-seh-gcc-.*\.zip$/, true);
    log('Downloading ' + asset.name + ' (C/C++ compiler, ~270 MB once) ...');
    await installArchive(asset.url, tool('mingw'), { sha256: asset.sha256, fileName: asset.name });
  }
  if (!exists(gcc)) throw new Error('gcc.exe missing after installing MinGW');
  // Appended (not prepended) so MinGW's tools never shadow Windows or toolchain commands of the same name.
  env.append.unshift(bin);
  env.vars.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = gcc;
  env.summary.push('gcc: ' + (/\d+\.\d+\.\d+/.exec(execOutput(gcc, ['--version']))?.[0] ?? 'installed') + ' (MinGW-w64)');
};

// ---- Rust (rustup + cargo) --------------------------------------------------------------------------------------

export const setupRust = async (env: ToolEnv, config: Toolchains['rust'], refresh: boolean): Promise<void> => {
  const RUSTUP_HOME = tool('rust', 'rustup');
  const CARGO_HOME = tool('rust', 'cargo');
  const rustupEnv = { ...process.env, RUSTUP_HOME, CARGO_HOME };
  const rustup = path.join(CARGO_HOME, 'bin', 'rustup.exe');
  if (dryRun) { log('(dry run) would provision Rust ' + config.toolchain + ' (' + config.host + ')'); return; }
  if (!exists(rustup)) {
    const init = tool('rust', 'rustup-init.exe');
    log('Downloading rustup ...');
    await download('https://static.rust-lang.org/rustup/dist/' + (arch === 'arm64' ? 'aarch64' : 'x86_64') + '-pc-windows-msvc/rustup-init.exe', init);
    exec(init, ['-y', '--no-modify-path', '--profile', 'default', '--default-host', config.host, '--default-toolchain', config.toolchain], { env: rustupEnv });
  } else {
    exec(rustup, ['default', config.toolchain], { env: rustupEnv, stdio: 'ignore' });
    if (refresh) exec(rustup, ['update'], { env: rustupEnv });
  }
  Object.assign(env.vars, { RUSTUP_HOME, CARGO_HOME });
  env.prepend.push(path.join(CARGO_HOME, 'bin'));
  env.summary.push('rust: ' + execOutput(path.join(CARGO_HOME, 'bin', 'rustc.exe'), ['--version'], { env: rustupEnv }).replace(/^rustc /, '') + ' [' + config.host + ']');
};

// ---- .NET SDK (C#) ----------------------------------------------------------------------------------------------

export const setupDotnet = async (env: ToolEnv, config: Toolchains['dotnet'], refresh: boolean): Promise<void> => {
  const root = tool('dotnet');
  const marker = path.join(root, '.agent-sandbox-installed.json');
  if (dryRun) { log('(dry run) would provision .NET SDK channels ' + config.channels.join(', ')); return; }
  const done: Record<string, boolean> = exists(marker) && !refresh ? JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, boolean> : {};
  const script = tool('dotnet-install.ps1');
  const installs: [string, string[]][] = config.channels.map((c) => ['channel:' + c, ['-Channel', c]]);
  const globalJson = path.join(workspace, 'global.json');
  if (exists(globalJson)) installs.push(['global.json:' + fs.readFileSync(globalJson, 'utf8').replace(/\s+/g, ''), ['-JSonFile', globalJson]]);
  for (const [key, args] of installs.filter(([k]) => !done[k])) {
    if (!exists(script) || refresh) await download('https://dot.net/v1/dotnet-install.ps1', script);
    log('Installing .NET SDK (' + key + ') ...');
    exec('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args, '-InstallDir', root, '-NoPath']);
    done[key] = true;
    fs.writeFileSync(marker, JSON.stringify(done, null, 2));
  }
  const home = mkdirp(tool('dotnet-home'));
  Object.assign(env.vars, { DOTNET_ROOT: root, DOTNET_CLI_HOME: home, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', NUGET_PACKAGES: tool('nuget', 'packages') });
  env.prepend.push(root, path.join(home, '.dotnet', 'tools'));
  env.summary.push('dotnet: ' + execOutput(path.join(root, 'dotnet.exe'), ['--list-sdks']).split(/\r?\n/).map((l) => l.split(' ')[0]).filter(Boolean).join(', '));
};

// ---- Bun and uv (claude-mem needs both; they are also handy on their own) ---------------------------------------

const setupSingleExe = async (env: ToolEnv, name: string, repo: string, pattern: RegExp, exeName: string, dir: string): Promise<void> => {
  if (dryRun) { log('(dry run) would provision ' + name); return; }
  if (!exists(path.join(dir, exeName))) {
    const asset = await githubAsset(repo, pattern);
    log('Downloading ' + asset.name + ' ...');
    await installArchive(asset.url, dir, { sha256: asset.sha256, locate: exeName, fileName: asset.name });
  }
  env.prepend.push(dir);
  env.summary.push(name + ': ' + (/\d+\.\d+\.\d+\S*/.exec(execOutput(path.join(dir, exeName), ['--version']))?.[0] ?? 'installed'));
};

export const setupBun = async (env: ToolEnv): Promise<void> => {
  await setupSingleExe(env, 'bun', 'oven-sh/bun', arch === 'arm64' ? /^bun-windows-aarch64\.zip$/ : /^bun-windows-x64\.zip$/, 'bun.exe', tool('bun', 'bin'));
  env.vars.BUN_INSTALL = tool('bun');
};

export const setupUv = async (env: ToolEnv): Promise<void> => {
  await setupSingleExe(env, 'uv', 'astral-sh/uv', arch === 'arm64' ? /^uv-aarch64-pc-windows-msvc\.zip$/ : /^uv-x86_64-pc-windows-msvc\.zip$/, 'uv.exe', tool('uv'));
  Object.assign(env.vars, { UV_CACHE_DIR: tool('uv-cache'), UV_PYTHON_INSTALL_DIR: tool('uv-python'), UV_TOOL_DIR: tool('uv-tools'), UV_TOOL_BIN_DIR: tool('uv-bin') });
  env.prepend.push(tool('uv-bin'));
};

/** Provisions every enabled toolchain and returns the combined environment. */
export const setupToolchains = async (config: Toolchains, versions: ToolVersions, options: { gitEnabled: boolean; hostGit: boolean; refresh: boolean }): Promise<ToolEnv> => {
  const env = emptyEnv();
  env.prepend.push(mkdirp(tool('bin')));
  if (options.gitEnabled) await step('Git', env, () => setupGit(env, options.hostGit, options.refresh));
  await step('nvm + Node ' + versions.node.spec, env, () => setupNode(env, versions));
  if (config.python.enabled) await step('Python', env, () => setupPython(env, config.python, versions));
  if (config.cpp.enabled) await step('C/C++ (MinGW-w64)', env, () => setupCpp(env));
  if (config.rust.enabled) await step('Rust', env, () => setupRust(env, config.rust, options.refresh));
  if (config.dotnet.enabled) await step('.NET SDK', env, () => setupDotnet(env, config.dotnet, options.refresh));
  if (config.bun.enabled) await step('Bun', env, () => setupBun(env));
  if (config.uv.enabled) await step('uv', env, () => setupUv(env));
  return env;
};

export { pickPackageVersion };
