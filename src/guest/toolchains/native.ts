// Compiled languages: C/C++ (MinGW-w64 GCC), Rust (rustup + cargo) and C# (.NET SDK).
import fs from 'node:fs';
import path from 'node:path';
import type { Toolchains } from '../../core/types.js';
import { download, githubAsset, installArchive } from '../../shared/download.js';
import { dryRun, exec, execOutput, exists, log, mkdirp, workspace } from '../env.js';
import { arch, tool, versionOf, type ToolEnv } from './common.js';

/** MinGW-w64 GCC from WinLibs: gcc/g++/mingw32-make for the agent, and the linker for Rust's GNU host. */
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
  env.summary.push('gcc: ' + versionOf(gcc) + ' (MinGW-w64)');
};

export const setupRust = async (env: ToolEnv, config: Toolchains['rust'], refresh: boolean): Promise<void> => {
  const RUSTUP_HOME = tool('rust', 'rustup');
  const CARGO_HOME = tool('rust', 'cargo');
  const rustEnv = { env: { ...process.env, RUSTUP_HOME, CARGO_HOME } };
  const rustup = path.join(CARGO_HOME, 'bin', 'rustup.exe');
  if (dryRun) { log('(dry run) would provision Rust ' + config.toolchain + ' (' + config.host + ')'); return; }
  if (!exists(rustup)) {
    const init = tool('rust', 'rustup-init.exe');
    log('Downloading rustup ...');
    await download('https://static.rust-lang.org/rustup/dist/' + (arch === 'arm64' ? 'aarch64' : 'x86_64') + '-pc-windows-msvc/rustup-init.exe', init);
    exec(init, ['-y', '--no-modify-path', '--profile', 'default', '--default-host', config.host, '--default-toolchain', config.toolchain], rustEnv);
  } else {
    exec(rustup, ['default', config.toolchain], { ...rustEnv, stdio: 'ignore' });
    if (refresh) exec(rustup, ['update'], rustEnv);
  }
  Object.assign(env.vars, { RUSTUP_HOME, CARGO_HOME });
  env.prepend.push(path.join(CARGO_HOME, 'bin'));
  env.summary.push('rust: ' + versionOf(path.join(CARGO_HOME, 'bin', 'rustc.exe'), ['--version'], rustEnv) + ' [' + config.host + ']');
};

/** .NET SDK channels from config plus whatever the workspace's global.json pins. Installs are remembered in a marker. */
export const setupDotnet = async (env: ToolEnv, config: Toolchains['dotnet'], refresh: boolean): Promise<void> => {
  const root = tool('dotnet');
  const marker = path.join(root, '.agent-sandbox-installed.json');
  const script = tool('dotnet-install.ps1');
  if (dryRun) { log('(dry run) would provision .NET SDK channels ' + config.channels.join(', ')); return; }
  const done: Record<string, boolean> = exists(marker) && !refresh ? JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, boolean> : {};
  const globalJson = path.join(workspace, 'global.json');
  const installs: [string, string[]][] = [
    ...config.channels.map((c): [string, string[]] => ['channel:' + c, ['-Channel', c]]),
    ...(exists(globalJson) ? [['global.json:' + fs.readFileSync(globalJson, 'utf8').replace(/\s+/g, ''), ['-JSonFile', globalJson]] as [string, string[]]] : []),
  ];
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
