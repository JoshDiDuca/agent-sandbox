// C/C++: MinGW-w64 GCC (with CMake, Ninja, make) and the flex/bison parser generators.
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { githubAsset, installArchive } from '../../../shared/download.js';
import { dryRun, exists, log, warn } from '../../env.js';
import { arch, tool, versionOf, type ToolEnv } from '../common.js';
import { CMAKE_FLOOR, cmakeTooOld } from '../versions.js';

/** MinGW-w64 GCC from WinLibs: gcc/g++/mingw32-make for the agent, and the linker for Rust's GNU host. */
export const setupCpp = async (env: ToolEnv, config: Toolchains['cpp']): Promise<void> => {
  const bin = tool('mingw', 'mingw64', 'bin');
  const gcc = path.join(bin, 'gcc.exe');
  if (dryRun) { log('(dry run) would provision MinGW-w64 GCC'); return; }
  if (!exists(gcc)) {
    const asset = await githubAsset('brechtsanders/winlibs_mingw', arch === 'arm64' ? /^winlibs-aarch64-.*\.zip$/ : /^winlibs-x86_64-posix-seh-gcc-.*\.zip$/, true);
    log('Downloading the C/C++ compiler, MinGW-w64 GCC with CMake and Ninja (~270 MB once) ...');
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
    log('Downloading win_flex / win_bison (~1 MB once) ...');
    await installArchive(asset.url, dir, { sha256: asset.sha256, locate: 'win_bison.exe', fileName: asset.name });
  }
  env.append.push(dir);
  env.summary.push('win_flex/win_bison: ' + versionOf(path.join(dir, 'win_bison.exe')));
};
