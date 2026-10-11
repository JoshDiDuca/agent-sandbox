// Bun and uv: single-binary tools from GitHub releases (claude-mem needs both; handy on their own too).
import path from 'node:path';
import { githubAsset, installArchive } from '../../shared/download.js';
import { dryRun, exists, log } from '../env.js';
import { arch, tool, versionOf, type ToolEnv } from './common.js';

const setupSingleExe = async (env: ToolEnv, name: string, repo: string, pattern: RegExp, exeName: string, dir: string): Promise<void> => {
  if (dryRun) { log('(dry run) would provision ' + name); return; }
  if (!exists(path.join(dir, exeName))) {
    const asset = await githubAsset(repo, pattern);
    log('Downloading ' + asset.name + ' ...');
    await installArchive(asset.url, dir, { sha256: asset.sha256, locate: exeName, fileName: asset.name });
  }
  env.prepend.push(dir);
  env.summary.push(name + ': ' + versionOf(path.join(dir, exeName)));
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
