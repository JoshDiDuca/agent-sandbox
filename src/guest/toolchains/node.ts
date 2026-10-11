// Node through nvm-windows. Versions live in C:\AgentData\tools\nvm (persistent); the active-version symlink lives on
// the sandbox's own disk (C:\nvm\nodejs), because a symlink inside a mapped folder would point at the host's paths.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ToolVersions } from '../../core/types.js';
import { fetchJson, githubAsset, installArchive } from '../../shared/download.js';
import { dryRun, errMsg, exists, hostToolsDir, localDir, log, mkdirp, robocopy, warn } from '../env.js';
import { arch, resolveCached, tool, type ToolEnv } from './common.js';
import { pickNodeVersion, type NodeRelease } from './versions.js';


const NVM_HOME = tool('nvm');
const NVM_SYMLINK = path.join(localDir, 'nodejs');
const HOST_NVM = path.join(hostToolsDir, 'nvm');

const resolveNode = (spec: string): Promise<string> => resolveCached('node:' + spec, async () => {
  const exact = spec.replace(/^v/, '');
  if (/^\d+\.\d+\.\d+$/.test(exact)) return exact;
  const releases = await fetchJson<NodeRelease[]>('https://nodejs.org/dist/index.json');
  return pickNodeVersion(releases, spec) ?? Promise.reject(new Error('No Node.js release matches "' + spec + '"'));
});

const nvm = (args: string[]): string => {
  const result = spawnSync(path.join(NVM_HOME, 'nvm.exe'), args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, NVM_HOME, NVM_SYMLINK } });
  return (result.stdout ?? '') + (result.stderr ?? '');
};

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
const installNodeVersion = (version: string): void => {
  const dir = path.join(NVM_HOME, 'v' + version);
  const fromHost = path.join(HOST_NVM, 'v' + version);
  if (exists(path.join(dir, 'node.exe'))) return;
  if (exists(path.join(fromHost, 'node.exe'))) { log('Copying Node ' + version + ' from this PC\'s nvm ...'); robocopy(fromHost, dir); return; }
  log('nvm install ' + version + ' ...');
  const out = nvm(['install', version]);
  if (!exists(path.join(dir, 'node.exe'))) throw new Error('nvm install ' + version + ' failed: ' + out.trim().split('\n').slice(-2).join(' '));
};

const activate = (version: string): void => {
  nvm(['use', version]);
  if (exists(path.join(NVM_SYMLINK, 'node.exe'))) return;
  fs.rmSync(NVM_SYMLINK, { recursive: true, force: true });
  fs.symlinkSync(path.join(NVM_HOME, 'v' + version), NVM_SYMLINK, 'junction');
};

export const setupNode = async (env: ToolEnv, versions: ToolVersions): Promise<void> => {
  if (dryRun) { log('(dry run) would provision nvm and Node ' + versions.node.spec + ' (from ' + versions.node.source + ')'); return; }
  await ensureNvm();
  fs.writeFileSync(path.join(NVM_HOME, 'settings.txt'), ['root: ' + NVM_HOME, 'path: ' + NVM_SYMLINK, 'arch: ' + (arch === 'arm64' ? 'arm64' : '64'), 'proxy: none', ''].join('\r\n'));
  mkdirp(localDir);
  for (const extra of versions.nodeExtra) {
    try { installNodeVersion(await resolveNode(extra)); } catch (e) { warn('Extra Node ' + extra + ': ' + errMsg(e)); }
  }
  const main = await resolveNode(versions.node.spec);
  installNodeVersion(main);
  activate(main);
  Object.assign(env.vars, { NVM_HOME, NVM_SYMLINK });
  env.prepend.push(NVM_HOME, NVM_SYMLINK);
  env.summary.push('node: ' + main + ' (from ' + versions.node.source + ', switch with nvm use)');
};
