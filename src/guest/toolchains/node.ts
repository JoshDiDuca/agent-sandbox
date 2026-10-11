// Node through nvm-windows. Versions live in C:\AgentData\tools\nvm (persistent); the active-version symlink lives on
// the sandbox's own disk (C:\nvm\nodejs), because a symlink inside a mapped folder would point at the host's paths.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Toolchains, ToolVersions } from '../../core/types.js';
import { fetchJson, githubAsset, installArchive } from '../../shared/download.js';
import { copyNode, dryRun, errMsg, execAsync, exists, hostToolsDir, localDir, log, mkdirp, warn } from '../env.js';
import { arch, installOnce, resolveCached, tool, type ToolEnv } from './common.js';
import { pickNodeVersion, pickSpreadVersions, type NodeRelease } from './versions.js';


const NVM_HOME = tool('nvm');
const NVM_SYMLINK = path.join(localDir, 'nodejs');
const HOST_NVM = path.join(hostToolsDir, 'nvm');
/** Most Node versions taken from this PC's nvm, the selected one included. */
const HOST_VERSIONS_MAX = 3;

const hostNvmVersions = (): string[] => exists(HOST_NVM)
  ? fs.readdirSync(HOST_NVM).filter((d) => /^v\d+\.\d+\.\d+$/.test(d) && exists(path.join(HOST_NVM, d, 'node.exe'))).map((d) => d.slice(1))
  : [];

const resolveNode = (spec: string): Promise<string> => resolveCached('node:' + spec, async () => {
  const exact = spec.replace(/^v/, '');
  if (/^\d+\.\d+\.\d+$/.test(exact)) return exact;
  const releases = await fetchJson<NodeRelease[]>('https://nodejs.org/dist/index.json');
  return pickNodeVersion(releases, spec) ?? Promise.reject(new Error('No Node.js release matches "' + spec + '"'));
});

/** nvm unpacks here and then moves the version into NVM_HOME: a move from the sandbox's own disk into a mapped folder
 *  fails silently, so it must be on the same (mapped) disk. */
const NVM_TEMP = path.join(NVM_HOME, '.tmp');

/** nvm, without blocking the event loop (`nvm install` downloads). Resolves with its output. */
const nvm = (args: string[]): Promise<string> => new Promise((resolve) => {
  const child = spawn(path.join(NVM_HOME, 'nvm.exe'), args, { windowsHide: true, env: { ...process.env, NVM_HOME, NVM_SYMLINK, TEMP: NVM_TEMP, TMP: NVM_TEMP } });
  let out = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
  child.once('error', (e) => resolve(out + e.message));
  child.once('close', () => resolve(out));
});

/** nvm itself: copied from the host's nvm when there is one, else the portable build. */
const ensureNvm = async (): Promise<void> => {
  if (exists(path.join(NVM_HOME, 'nvm.exe'))) return;
  if (exists(path.join(HOST_NVM, 'nvm.exe'))) {
    log('Copying nvm from this PC ...');
    mkdirp(NVM_HOME);
    for (const file of fs.readdirSync(HOST_NVM).filter((f) => /\.(exe|cmd|vbs)$/i.test(f))) fs.copyFileSync(path.join(HOST_NVM, file), path.join(NVM_HOME, file));
    return;
  }
  // nvm-windows 2.x only ships installers; the portable build is the newest 1.x release that has nvm-noinstall.zip.
  const asset = await githubAsset('coreybutler/nvm-windows', /^nvm-noinstall\.zip$/, true);
  log('Downloading nvm-windows (' + asset.url.split('/').slice(-2, -1)[0] + ') ...');
  await installArchive(asset.url, NVM_HOME, { sha256: asset.sha256, locate: 'nvm.exe', fileName: asset.name });
};

/** A Node version: from the host's nvm when it has it (fast, offline), else `nvm install`. */
const installNodeVersion = async (version: string): Promise<void> => {
  const dir = path.join(NVM_HOME, 'v' + version);
  const fromHost = path.join(HOST_NVM, 'v' + version);
  if (exists(path.join(dir, 'node.exe'))) return;
  if (exists(path.join(fromHost, 'node.exe'))) { log('Copying Node ' + version + ' from this PC\'s nvm (without global packages) ...'); copyNode(fromHost, dir); return; }
  log('nvm install ' + version + ' ...');
  mkdirp(NVM_TEMP);
  const out = await nvm(['install', version]);
  fs.rmSync(NVM_TEMP, { recursive: true, force: true });
  if (!exists(path.join(dir, 'node.exe'))) throw new Error('nvm install ' + version + ' failed: ' + out.trim().split('\n').slice(-2).join(' '));
};

const activate = async (version: string): Promise<void> => {
  await nvm(['use', version]);
  if (exists(path.join(NVM_SYMLINK, 'node.exe'))) return;
  fs.rmSync(NVM_SYMLINK, { recursive: true, force: true });
  fs.symlinkSync(path.join(NVM_HOME, 'v' + version), NVM_SYMLINK, 'junction');
};

export const setupNode = async (env: ToolEnv, versions: ToolVersions, config: Toolchains['node']): Promise<void> => {
  if (dryRun) { log('(dry run) would provision nvm and Node ' + versions.node.spec + ' (from ' + versions.node.source + ')'); return; }
  await ensureNvm();
  fs.writeFileSync(path.join(NVM_HOME, 'settings.txt'), ['root: ' + NVM_HOME, 'path: ' + NVM_SYMLINK, 'arch: ' + (arch === 'arm64' ? 'arm64' : '64'), 'proxy: none', ''].join('\r\n'));
  mkdirp(localDir);
  for (const extra of versions.nodeExtra) {
    try { await installNodeVersion(await resolveNode(extra)); } catch (e) { warn('Extra Node ' + extra + ': ' + errMsg(e)); }
  }
  const main = await resolveNode(versions.node.spec);
  await installNodeVersion(main);
  // A few more of this PC's versions (copied, never downloaded) so `nvm use` works offline; capped to keep boot fast.
  for (const version of pickSpreadVersions(hostNvmVersions(), main, HOST_VERSIONS_MAX).slice(1)) {
    try { await installNodeVersion(version); } catch (e) { warn('Node ' + version + ' from this PC: ' + errMsg(e)); }
  }
  await activate(main);
  Object.assign(env.vars, { NVM_HOME, NVM_SYMLINK });
  env.prepend.push(NVM_HOME, NVM_SYMLINK);
  env.summary.push('node: ' + main + ' (from ' + versions.node.source + ', switch with nvm use)');
  await packageManagers(env, config, main);
};

/** Global npm packages (per Node version, like nvm keeps them) and pnpm/yarn through corepack. */
const packageManagers = async (env: ToolEnv, config: Toolchains['node'], version: string): Promise<void> => {
  const dir = path.join(NVM_HOME, 'v' + version);
  const nodeEnv = { ...process.env, PATH: dir + path.delimiter + (process.env.PATH ?? '') };
  const npm = (args: string[]): Promise<void> => execAsync(path.join(dir, 'node.exe'), [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args], { env: nodeEnv, stdio: 'ignore' });
  const corepackJs = path.join(dir, 'node_modules', 'corepack', 'dist', 'corepack.js');
  // Versions copied from this PC come without their global packages, corepack included, and Node 25+ dropped it.
  const extra = config.corepack && !exists(corepackJs) ? ['corepack'] : [];
  await installOnce(env, 'npm@' + version, [...extra, ...config.globalPackages], (pkg) => npm(['install', '--global', pkg, '--no-fund', '--no-audit']));
  if (!config.corepack) return;
  // Without a packageManager pin, corepack's own known-good versions: the newest pnpm can be one this corepack cannot
  // start. Mapped folders allow no symlinks, so pnpm uses a flat (hoisted) node_modules instead of its linked layout.
  Object.assign(env.vars, { COREPACK_HOME: tool('corepack'), COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_DEFAULT_TO_LATEST: '0', npm_config_node_linker: 'hoisted' });
  try {
    await execAsync(path.join(dir, 'node.exe'), [corepackJs, 'enable', '--install-directory', mkdirp(tool('bin')), 'pnpm', 'yarn'], { env: nodeEnv, stdio: 'ignore' });
    env.summary.push('pnpm, yarn: via corepack (package.json "packageManager" picks the version)');
  } catch (e) { warn('corepack enable failed: ' + errMsg(e)); }
};
