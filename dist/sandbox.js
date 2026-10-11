import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
//TS import type { GenerateOptions, Generated, ResolvedMapping, ProfileResult } from './types.js';
import { assertNoGuestOverlap } from './config.js';
import { stageClaudeProfile } from './profile.js';
import { dirExists, ensureDir, expandPath, fail, isRootPath, isUserProfile, writeJson, xmlEscape } from './util.js';

function toggle(value/*: boolean*/)/*: string*/ { return value ? 'Enable' : 'Disable'; }

export function resolveMemoryMb(options/*: GenerateOptions*/)/*: number*/ {
  const sandbox = options.config.sandbox;
  if (sandbox.memoryMb !== 'auto') return sandbox.memoryMb;
  const freeMb = Math.floor((options.freeMemoryBytes ?? os.freemem()) / 1048576);
  const usable = Math.min(sandbox.maxMemoryMb, freeMb - sandbox.reserveHostMb);
  const rounded = Math.floor(usable / 1024) * 1024;
  if (rounded < 4096) fail('Not enough free RAM for the sandbox (free ' + freeMb + ' MB, reserve ' + sandbox.reserveHostMb + ' MB). Close apps, lower sandbox.reserveHostMb, or set sandbox.memoryMb to a fixed value.');
  return rounded;
}

function copyDirectory(source/*: string*/, destination/*: string*/)/*: void*/ {
  ensureDir(path.dirname(destination));
  fs.cpSync(source, destination, { recursive: true, force: true });
}

export function generateSandbox(options/*: GenerateOptions*/)/*: Generated*/ {
  const { projectRoot, config, base, projectName, harnessName } = options;
  const project = config.projects[projectName];
  if (!project) fail('Unknown project: ' + projectName);
  const harness = harnessName === 'none' ? null : config.harnesses[harnessName];
  if (harnessName !== 'none' && !harness) fail('Unknown harness: ' + harnessName);

  const workspaceHost = options.workspaceOverride ? path.resolve(options.workspaceOverride) : expandPath(project.workspace, base);
  if (!dirExists(workspaceHost)) {
    if (options.workspaceOverride || !project.createWorkspace) fail('Workspace folder does not exist: ' + workspaceHost);
    ensureDir(workspaceHost);
  }
  if (isRootPath(workspaceHost) || isUserProfile(workspaceHost)) fail('Refusing to map a drive root or your whole user profile as the workspace: ' + workspaceHost);

  const storageRoot = expandPath(config.storage.root, base);
  const launchPath = path.join(storageRoot, 'launches', Date.now() + '-' + crypto.randomBytes(3).toString('hex'));
  const dataPath = path.join(storageRoot, 'data', projectName);
  ensureDir(launchPath);
  ensureDir(dataPath);

  const mappings/*: ResolvedMapping[]*/ = [
    { host: launchPath, guest: 'C:\\AgentLaunch', readOnly: true },
    { host: dataPath, guest: 'C:\\AgentData', readOnly: false },
    { host: workspaceHost, guest: project.guestWorkspace, readOnly: Boolean(project.readOnly) },
  ];
  for (const m of project.mappings ?? []) {
    const host = expandPath(m.host, base);
    if (!dirExists(host)) {
      if (m.optional) { console.warn('Skipping optional mapping (folder not found): ' + host); continue; }
      fail('Required mapping folder not found: ' + host);
    }
    if (isRootPath(host) || isUserProfile(host)) fail('Refusing broad mapping: ' + host);
    mappings.push({ host, guest: m.guest, readOnly: m.readOnly });
  }

  const hostTools/*: { node: boolean; harnessExecutable: string | null }*/ = { node: false, harnessExecutable: null };
  if (options.probe.nodeDir) { mappings.push({ host: options.probe.nodeDir, guest: 'C:\\HostTools\\node', readOnly: true }); hostTools.node = true; }
  if (options.probe.harnessExe && harness) {
    mappings.push({ host: options.probe.harnessExe.dir, guest: 'C:\\HostTools\\agents\\' + harnessName, readOnly: true });
    hostTools.harnessExecutable = options.probe.harnessExe.file;
  }
  assertNoGuestOverlap(mappings);

  const profile/*: ProfileResult*/ = harnessName === 'claude' ? stageClaudeProfile(config.claudeProfile, launchPath) : { hostDir: null, staged: [], skipped: [], credentials: false };

  const session = {
    version: 2,
    project: projectName,
    workspace: project.guestWorkspace,
    harnessName,
    harness,
    harnessArguments: options.harnessArgs,
    persistAgentState: config.storage.persistAgentState,
    networking: config.sandbox.networking,
    network: config.network,
    provisioning: config.provisioning,
    hostTools,
    hooks: config.hooks,
    claudeProfile: { overwrite: config.claudeProfile.overwrite, items: profile.staged, credentials: profile.credentials },
  };
  writeJson(path.join(launchPath, 'session.json'), session);

  const guestDir = path.join(projectRoot, 'dist', 'guest');
  if (!fs.existsSync(path.join(guestDir, 'main.js'))) fail('Missing build output: ' + path.join(guestDir, 'main.js') + ' (run "npm run build").');
  ensureDir(path.join(launchPath, 'guest'));
  for (const file of fs.readdirSync(guestDir)) if (file.endsWith('.js')) fs.copyFileSync(path.join(guestDir, file), path.join(launchPath, 'guest', file));
  fs.writeFileSync(path.join(launchPath, 'guest', 'package.json'), '{ "type": "module" }\n', 'utf8');
  ensureDir(path.join(launchPath, 'sandbox'));
  for (const file of ['bootstrap.ps1', 'logon.cmd']) fs.copyFileSync(path.join(projectRoot, 'sandbox', file), path.join(launchPath, 'sandbox', file));
  const hooksSource = path.join(projectRoot, 'hooks');
  if (dirExists(hooksSource)) copyDirectory(hooksSource, path.join(launchPath, 'hooks'));
  const extraHooks = path.join(launchPath, 'hooks', 'pre-agent');
  ensureDir(extraHooks);
  options.scripts.forEach((script/*: string*/, index/*: number*/) => {
    const source = path.resolve(script);
    if (!fs.existsSync(source)) fail('--script file not found: ' + source);
    fs.copyFileSync(source, path.join(extraHooks, '90-cli-' + index + '-' + path.basename(source)));
  });

  const memoryMb = resolveMemoryMb(options);
  const s = config.sandbox;
  const folders = mappings.map((m/*: ResolvedMapping*/) => '<MappedFolder><HostFolder>' + xmlEscape(m.host) + '</HostFolder><SandboxFolder>' + xmlEscape(m.guest) + '</SandboxFolder><ReadOnly>' + String(m.readOnly) + '</ReadOnly></MappedFolder>').join('');
  const logon = 'C:\\AgentLaunch\\sandbox\\logon.cmd';
  const wsb = '<Configuration>'
    + '<MemoryInMB>' + memoryMb + '</MemoryInMB>'
    + '<vGPU>' + toggle(s.vGpu) + '</vGPU>'
    + '<Networking>' + toggle(s.networking) + '</Networking>'
    + '<ClipboardRedirection>' + toggle(s.clipboard) + '</ClipboardRedirection>'
    + '<AudioInput>' + toggle(s.audioInput) + '</AudioInput>'
    + '<VideoInput>' + toggle(s.videoInput) + '</VideoInput>'
    + '<PrinterRedirection>' + toggle(s.printerRedirection) + '</PrinterRedirection>'
    + '<ProtectedClient>' + toggle(s.protectedClient) + '</ProtectedClient>'
    + '<MappedFolders>' + folders + '</MappedFolders>'
    + '<LogonCommand><Command>' + xmlEscape(logon) + '</Command></LogonCommand>'
    + '</Configuration>';
  const wsbPath = path.join(launchPath, 'agent.wsb');
  fs.writeFileSync(wsbPath, wsb, 'utf8');
  return { wsbPath, launchPath, sessionPath: path.join(launchPath, 'session.json'), memoryMb, mappings, workspaceHost, profile };
}
