// Compiled languages: C/C++ (MinGW-w64 GCC, flex/bison), Rust (rustup + cargo), C# (.NET SDK and .NET Framework
// targeting), and Mesa for running OpenGL programs without a GPU.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Toolchains } from '../../core/types.js';
import { download, fetchJson, githubAsset, installArchive } from '../../shared/download.js';
import { readJsonFile, writeJsonAtomic } from '../../shared/rundir.js';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, errMsg, execAsync, execOutput, exists, log, mkdirp, warn, workspace } from '../env.js';
import { arch, installOnce, tool, versionOf, type ToolEnv } from './common.js';
import { CMAKE_FLOOR, cmakeTooOld } from './versions.js';
import { crateInstaller } from './binstall.js';
import { installedMsvcEnv } from './msvc.js';

/** MinGW-w64 GCC from WinLibs: gcc/g++/mingw32-make for the agent, and the linker for Rust's GNU host. */
export const setupCpp = async (env: ToolEnv, config: Toolchains['cpp']): Promise<void> => {
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
  const cmake = versionOf(path.join(bin, 'cmake.exe'));
  if (cmakeTooOld(cmake)) warn('The bundled CMake ' + cmake + ' is older than ' + CMAKE_FLOOR + ', which many projects need; set toolchains.cpp.enabled to refresh it, or install a newer CMake into C:\\AgentData\\tools\\bin.');
  env.summary.push('gcc: ' + versionOf(gcc) + ' (MinGW-w64, with cmake ' + cmake + ', ninja, premake5)');
  if (config.flexBison) await setupFlexBison(env);
};

/** win_flex / win_bison (CMake's FindFLEX/FindBISON look for these names). Kept with the C/C++ tools on PATH. */
const setupFlexBison = async (env: ToolEnv): Promise<void> => {
  const dir = tool('winflexbison');
  if (!exists(path.join(dir, 'win_bison.exe'))) {
    const asset = await githubAsset('lexxmark/winflexbison', /^win_flex_bison-[\d.]+\.zip$/);
    log('Downloading ' + asset.name + ' ...');
    await installArchive(asset.url, dir, { sha256: asset.sha256, locate: 'win_bison.exe', fileName: asset.name });
  }
  env.append.push(dir);
  env.summary.push('win_flex/win_bison: ' + versionOf(path.join(dir, 'win_bison.exe')));
};

/**
 * Mesa 3D for Windows (llvmpipe): OpenGL 4.5 on the CPU when the sandbox has no GPU. Windows only offers OpenGL 1.1 in
 * software, and opengl32.dll cannot be replaced system-wide, so programs pick Mesa up from their own folder.
 */
export const setupMesa = async (env: ToolEnv, config: Toolchains['mesa']): Promise<void> => {
  if (dryRun) { log('(dry run) would provision Mesa 3D'); return; }
  const root = tool('mesa');
  const dir = path.join(root, arch === 'arm64' ? 'arm64' : 'x64');
  if (!exists(path.join(dir, 'opengl32.dll'))) {
    const asset = await githubAsset('pal1000/mesa-dist-win', /^mesa3d-[\d.]+-release-msvc\.7z$/);
    log('Downloading ' + asset.name + ' (software OpenGL) ...');
    await installArchive(asset.url, root, { sha256: asset.sha256, locate: 'opengl32.dll', up: 1, fileName: asset.name });
  }
  Object.assign(env.vars, { MESA_DIR: dir, GALLIUM_DRIVER: 'llvmpipe' });
  env.summary.push('mesa (software OpenGL 4.5): copy opengl32.dll + libgallium_wgl.dll from %MESA_DIR% next to a game\'s .exe');
  if (config.vulkan) await setupLavapipe(env, dir);
};

const VULKAN_RUNTIME = 'https://sdk.lunarg.com/sdk/download/latest/windows/vulkan-runtime-components.zip';

/**
 * Software Vulkan: Mesa's lavapipe plus the Khronos loader (vulkan-1.dll, from LunarG's runtime components; Windows
 * Sandbox has no Vulkan loader). The loader ignores VK_DRIVER_FILES in elevated processes, and everything in the
 * sandbox runs elevated, so lavapipe is registered where the loader looks (HKLM; the registry is new every boot).
 */
const setupLavapipe = async (env: ToolEnv, mesaDir: string): Promise<void> => {
  const icd = path.join(mesaDir, arch === 'arm64' ? 'lvp_icd.aarch64.json' : 'lvp_icd.x86_64.json');
  if (!exists(icd)) throw new Error('this Mesa build has no lavapipe (' + path.basename(icd) + ')');
  const dir = tool('vulkan');
  if (!exists(path.join(dir, 'vulkan-1.dll'))) {
    log('Downloading the Vulkan loader (LunarG runtime components) ...');
    // LunarG publishes no checksum for this zip; it comes over HTTPS from LunarG, the Khronos SDK's maintainer.
    // The zip has x86 and x64 folders: only the 64-bit loader (and vulkaninfo) is extracted.
    await installArchive(VULKAN_RUNTIME, dir, { locate: 'vulkan-1.dll', fileName: 'vulkan-runtime.zip', members: ['*/x64/*'] });
  }
  await execAsync(SYSTEM.reg(), ['add', 'HKLM\\SOFTWARE\\Khronos\\Vulkan\\Drivers', '/v', icd, '/t', 'REG_DWORD', '/d', '0', '/f'], { stdio: 'ignore' });
  env.prepend.push(dir);
  env.summary.push('vulkan: lavapipe (software Vulkan 1.4 on the CPU), vulkaninfo on PATH; WGPU_BACKEND=vulkan for wgpu');
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
    await execAsync(init, ['-y', '--no-modify-path', '--profile', 'default', '--default-host', config.host, '--default-toolchain', config.toolchain], rustEnv);
  } else {
    // The host can change (GNU <-> msvc with toolchains.msvc): install the toolchain for it; a no-op when it is there.
    await execAsync(rustup, ['set', 'default-host', config.host], { ...rustEnv, stdio: 'ignore' });
    await execAsync(rustup, ['toolchain', 'install', config.toolchain, '--profile', 'default', '--no-self-update'], { ...rustEnv, stdio: 'ignore' });
    await execAsync(rustup, ['default', config.toolchain], { ...rustEnv, stdio: 'ignore' });
    if (refresh) await execAsync(rustup, ['update'], rustEnv);
  }
  Object.assign(env.vars, { RUSTUP_HOME, CARGO_HOME });
  env.prepend.push(path.join(CARGO_HOME, 'bin'));
  env.summary.push('rust: ' + versionOf(path.join(CARGO_HOME, 'bin', 'rustc.exe'), ['--version'], rustEnv) + ' [' + config.host + ']');
  const toolchainKey = 'rustup@' + config.toolchain;
  await installOnce(env, toolchainKey + ' components', config.components, (c) => execAsync(rustup, ['component', 'add', c], rustEnv));
  await installOnce(env, toolchainKey + ' targets', config.targets, (t) => execAsync(rustup, ['target', 'add', t], rustEnv));
  // cargo install links with MSVC's link.exe (msvc host) or MinGW's gcc (GNU host). Those steps ran first, but their
  // PATH only reaches the agent at the end, so it is put together here.
  const msvc = config.host.endsWith('-msvc') ? installedMsvcEnv() : null;
  const mingw = tool('mingw', 'mingw64', 'bin');
  const cargoEnv = msvc
    ? { env: { ...rustEnv.env, ...msvc.vars, PATH: [path.join(CARGO_HOME, 'bin'), ...msvc.path, process.env.PATH ?? ''].join(path.delimiter) } }
    : { env: { ...rustEnv.env, CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER: path.join(mingw, 'gcc.exe'), PATH: [path.join(CARGO_HOME, 'bin'), mingw, process.env.PATH ?? ''].join(path.delimiter) } };
  // Prebuilt through cargo-binstall where the crate publishes a Windows build, else compiled (same "cargo" keys as before).
  await installOnce(env, 'cargo', config.crates, crateInstaller(CARGO_HOME, cargoEnv));
};

/** tools\dotnet\.agent-sandbox-installed.json: which install keys (channel:8.0, global.json:...) already ran. */
const DotnetMarker = z.record(z.string(), z.boolean());

/** .NET SDK channels from config plus whatever the workspace's global.json pins. Installs are remembered in a marker. */
export const setupDotnet = async (env: ToolEnv, config: Toolchains['dotnet'], refresh: boolean): Promise<void> => {
  const root = tool('dotnet');
  const marker = path.join(root, '.agent-sandbox-installed.json');
  const script = tool('dotnet-install.ps1');
  if (dryRun) { log('(dry run) would provision .NET SDK channels ' + config.channels.join(', ')); return; }
  // A corrupt or hand-edited marker just means "nothing recorded yet" (the installs are idempotent).
  const recorded = DotnetMarker.safeParse(exists(marker) && !refresh ? readJsonFile<unknown>(marker) : {});
  const done: Record<string, boolean> = recorded.success ? recorded.data : {};
  const globalJson = path.join(workspace, 'global.json');
  const installs: [string, string[]][] = [
    ...config.channels.map((c): [string, string[]] => ['channel:' + c, ['-Channel', c]]),
    ...(exists(globalJson) ? [['global.json:' + fs.readFileSync(globalJson, 'utf8').replace(/\s+/g, ''), ['-JSonFile', globalJson]] as [string, string[]]] : []),
  ];
  for (const [key, args] of installs.filter(([k]) => !done[k])) {
    if (!exists(script) || refresh) await download('https://dot.net/v1/dotnet-install.ps1', script);
    log('Installing .NET SDK (' + key + ') ...');
    await execAsync(SYSTEM.powershell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args, '-InstallDir', root, '-NoPath']);
    done[key] = true;
    writeJsonAtomic(marker, done);
  }
  const home = mkdirp(tool('dotnet-home'));
  Object.assign(env.vars, { DOTNET_ROOT: root, DOTNET_CLI_HOME: home, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', NUGET_PACKAGES: tool('nuget', 'packages') });
  env.prepend.push(root, path.join(home, '.dotnet', 'tools'));
  env.summary.push('dotnet: ' + execOutput(path.join(root, 'dotnet.exe'), ['--list-sdks']).split(/\r?\n/).map((l) => l.split(' ')[0]).filter(Boolean).join(', '));
  const dotnet = path.join(root, 'dotnet.exe');
  const dotnetEnv = { env: { ...process.env, ...env.vars, PATH: root + path.delimiter + (process.env.PATH ?? '') } };
  await installOnce(env, 'dotnet workload', config.workloads, (w) => execAsync(dotnet, ['workload', 'install', w, '--skip-manifest-update'], dotnetEnv));
  await installOnce(env, 'dotnet tool', config.tools, (t) => execAsync(dotnet, ['tool', 'install', '--global', t], dotnetEnv));
  await setupFrameworkReferences(env, config.frameworkTargets);
  if (config.netfx35) await setupNetFx35(env);
};

/**
 * .NET Framework reference assemblies (the "targeting packs" Visual Studio would install) from NuGet, so net4x projects,
 * old-style .csproj included, build with the SDK's MSBuild. MSBuild reads TargetFrameworkRootPath from the environment.
 * Running .NET Framework 4.8 apps needs nothing: Windows ships it.
 */
const setupFrameworkReferences = async (env: ToolEnv, targets: string[]): Promise<void> => {
  if (!targets.length) return;
  const root = tool('netfx-references');
  for (const target of targets) {
    const id = 'microsoft.netframework.referenceassemblies.' + target.toLowerCase();
    const marker = path.join(root, '.installed-' + target.toLowerCase());
    if (exists(marker)) continue;
    try {
      const { versions } = await fetchJson<{ versions: string[] }>('https://api.nuget.org/v3-flatcontainer/' + id + '/index.json');
      const version = versions.filter((v) => /^\d+(\.\d+)*$/.test(v)).pop();
      if (!version) throw new Error('no stable version of ' + id);
      log('Downloading .NET Framework reference assemblies (' + target + ') ...');
      const staging = tool('netfx-references-' + target.toLowerCase());
      await installArchive('https://api.nuget.org/v3-flatcontainer/' + id + '/' + version + '/' + id + '.' + version + '.nupkg', staging, { fileName: id + '.zip' });
      fs.cpSync(path.join(staging, 'build', '.NETFramework'), path.join(root, '.NETFramework'), { recursive: true });
      fs.rmSync(staging, { recursive: true, force: true });
      fs.writeFileSync(marker, version);
    } catch (e) { warn('.NET Framework reference assemblies ' + target + ' failed: ' + errMsg(e)); }
  }
  if (!exists(path.join(root, '.NETFramework'))) return;
  env.vars.TargetFrameworkRootPath = root + path.sep;
  env.summary.push('.NET Framework targeting: ' + fs.readdirSync(path.join(root, '.NETFramework')).join(', '));
};

/** .NET Framework 3.5 is a Windows feature the sandbox image lacks; DISM fetches it from Windows Update on every boot. */
const setupNetFx35 = async (env: ToolEnv): Promise<void> => {
  if (execOutput(SYSTEM.reg(), ['query', 'HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v3.5', '/v', 'Install']).includes('0x1')) { env.summary.push('.NET Framework 3.5: on'); return; }
  log('Enabling .NET Framework 3.5 (downloads from Windows Update, a few minutes) ...');
  try {
    await execAsync(SYSTEM.dism(), ['/Online', '/Enable-Feature', '/FeatureName:NetFx3', '/All', '/NoRestart', '/Quiet'], { stdio: 'ignore' });
    env.summary.push('.NET Framework 3.5: on');
  } catch (e) { warn('.NET Framework 3.5 could not be enabled: ' + errMsg(e)); env.summary.push('.NET Framework 3.5: FAILED'); }
};
