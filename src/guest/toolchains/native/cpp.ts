// C/C++: MinGW-w64 GCC (with CMake, Ninja, make) and the flex/bison parser generators.
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { dryRun } from '../../runtime/paths.js';
import { exists } from '../../runtime/fs.js';
import { log, warn } from '../../runtime/log.js';
import { arch, tool, versionOf, type ToolEnv } from '../tool-env.js';
import { installFromGithub } from '../install.js';
import { CMAKE_FLOOR, cmakeTooOld } from '../../../core/detect/versions.js';

/** MinGW-w64 GCC from WinLibs: gcc/g++/mingw32-make for the agent, and the linker for Rust's GNU host. */
export async function setupCpp(env: ToolEnv, config: Toolchains['cpp']): Promise<void> {
  const bin = tool('mingw', 'mingw64', 'bin');
  const gcc = path.join(bin, 'gcc.exe');
  if (dryRun) {
    log('(dry run) would provision MinGW-w64 GCC');
    return;
  }
  if (!exists(gcc)) {
    const pattern = arch === 'arm64' ? /^winlibs-aarch64-.*\.zip$/ : /^winlibs-x86_64-posix-seh-gcc-.*\.zip$/;
    await installFromGithub('brechtsanders/winlibs_mingw', pattern, {
      dest: tool('mingw'),
      what: 'the C/C++ compiler, MinGW-w64 GCC with CMake and Ninja (~270 MB once)',
      searchOlder: true,
    });
  }
  if (!exists(gcc)) throw new Error('gcc.exe missing after installing MinGW');
  // Appended (not prepended) so MinGW's tools never shadow Windows or toolchain commands of the same name.
  env.append.unshift(bin);
  env.vars.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = gcc;
  const cmake = versionOf(path.join(bin, 'cmake.exe'));
  if (cmakeTooOld(cmake))
    warn(
      'The bundled CMake ' +
        cmake +
        ' is older than ' +
        CMAKE_FLOOR +
        ', which many projects need; set toolchains.cpp.enabled to refresh it, or install a newer CMake into C:\\AgentData\\tools\\bin.',
    );
  env.summary.push('gcc: ' + versionOf(gcc) + ' (MinGW-w64, with cmake ' + cmake + ', ninja, premake5)');
  if (config.flexBison) await setupFlexBison(env);
}

/** win_flex / win_bison (CMake's FindFLEX/FindBISON look for these names). Kept with the C/C++ tools on PATH. */
const setupFlexBison = async (env: ToolEnv): Promise<void> => {
  const dir = tool('winflexbison');
  if (!exists(path.join(dir, 'win_bison.exe'))) {
    await installFromGithub('lexxmark/winflexbison', /^win_flex_bison-[\d.]+\.zip$/, {
      dest: dir,
      what: 'win_flex / win_bison (~1 MB once)',
      locate: 'win_bison.exe',
    });
  }
  env.append.push(dir);
  env.summary.push('win_flex/win_bison: ' + versionOf(path.join(dir, 'win_bison.exe')));
};
