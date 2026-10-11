// Mesa for running OpenGL and Vulkan programs without a GPU (llvmpipe, lavapipe).
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { installArchive } from '../../../shared/download.js';
import { SYSTEM } from '../../../shared/system.js';
import { dryRun, execAsync, exists, log } from '../../env.js';
import { arch, installFromGithub, tool, type ToolEnv } from '../common.js';

/**
 * Mesa 3D for Windows (llvmpipe): OpenGL 4.5 on the CPU when the sandbox has no GPU. Windows only offers OpenGL 1.1 in
 * software, and opengl32.dll cannot be replaced system-wide, so programs pick Mesa up from their own folder.
 */
export const setupMesa = async (env: ToolEnv, config: Toolchains['mesa']): Promise<void> => {
  if (dryRun) { log('(dry run) would provision Mesa 3D'); return; }
  const root = tool('mesa');
  const dir = path.join(root, arch === 'arm64' ? 'arm64' : 'x64');
  if (!exists(path.join(dir, 'opengl32.dll'))) {
    await installFromGithub('pal1000/mesa-dist-win', /^mesa3d-[\d.]+-release-msvc\.7z$/, { dest: root, what: 'Mesa 3D for software OpenGL (~100 MB once)', locate: 'opengl32.dll', up: 1 });
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
    log('Downloading the Vulkan loader (~10 MB once) ...');
    // LunarG publishes no checksum for this zip; it comes over HTTPS from LunarG, the Khronos SDK's maintainer.
    // The zip has x86 and x64 folders: only the 64-bit loader (and vulkaninfo) is extracted.
    await installArchive(VULKAN_RUNTIME, dir, { locate: 'vulkan-1.dll', fileName: 'vulkan-runtime.zip', members: ['*/x64/*'] });
  }
  await execAsync(SYSTEM.reg(), ['add', 'HKLM\\SOFTWARE\\Khronos\\Vulkan\\Drivers', '/v', icd, '/t', 'REG_DWORD', '/d', '0', '/f'], { stdio: 'ignore' });
  env.prepend.push(dir);
  env.summary.push('vulkan: lavapipe (software Vulkan 1.4 on the CPU), vulkaninfo on PATH; WGPU_BACKEND=vulkan for wgpu');
};
