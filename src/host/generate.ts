import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config, GenerateOptions, Generated, GuestSession, ProfileResult, ResolvedMapping } from '../core/types.js';
import { assertNoGuestOverlap, userDir } from '../core/config.js';
import { capturePersonalization } from './personalize.js';
import { hostClaudeDir, stageClaudeProfile } from './claude-profile.js';
import { dirExists, ensureDir, expandPath, fail, fileExists, homeDir, isRootPath, isUserProfile, writeJson, xmlEscape } from '../core/util.js';

export const GUEST = { launch: 'C:\\AgentLaunch', data: 'C:\\AgentData', hostTools: 'C:\\HostTools' } as const;
const HOOK_STAGES = ['pre-provision', 'pre-agent', 'post-agent'];
const toggle = (value: boolean): string => (value ? 'Enable' : 'Disable');

export const resolveMemoryMb = (sandbox: Config['sandbox'], freeMemoryBytes = os.freemem()): number => {
  if (sandbox.memoryMb !== 'auto') return sandbox.memoryMb;
  const freeMb = Math.floor(freeMemoryBytes / 1048576);
  const rounded = Math.floor(Math.min(sandbox.maxMemoryMb, freeMb - sandbox.reserveHostMb) / 1024) * 1024;
  if (rounded < 4096) fail('Not enough free RAM for the sandbox (free ' + freeMb + ' MB, reserve ' + sandbox.reserveHostMb + ' MB). Close apps, lower sandbox.reserveHostMb, or set sandbox.memoryMb to a fixed value.');
  return rounded;
};

export const buildWsb = (config: Config, memoryMb: number, mappings: ResolvedMapping[]): string => {
  const s = config.sandbox;
  const folders = mappings.map((m) => '<MappedFolder><HostFolder>' + xmlEscape(m.host) + '</HostFolder><SandboxFolder>' + xmlEscape(m.guest) + '</SandboxFolder><ReadOnly>' + String(m.readOnly) + '</ReadOnly></MappedFolder>').join('');
  return '<Configuration>'
    + '<MemoryInMB>' + memoryMb + '</MemoryInMB>'
    + '<vGPU>' + toggle(s.vGpu) + '</vGPU>'
    + '<Networking>' + toggle(s.networking) + '</Networking>'
    + '<ClipboardRedirection>' + toggle(s.clipboard) + '</ClipboardRedirection>'
    + '<AudioInput>' + toggle(s.audioInput) + '</AudioInput>'
    + '<VideoInput>' + toggle(s.videoInput) + '</VideoInput>'
    + '<PrinterRedirection>' + toggle(s.printerRedirection) + '</PrinterRedirection>'
    + '<ProtectedClient>' + toggle(s.protectedClient) + '</ProtectedClient>'
    + '<MappedFolders>' + folders + '</MappedFolders>'
    + '<LogonCommand><Command>' + xmlEscape(GUEST.launch + '\\sandbox\\logon.cmd') + '</Command></LogonCommand>'
    + '</Configuration>';
};

const collectMappings = (o: GenerateOptions, launchPath: string): ResolvedMapping[] => {
  const { config, dataPath, workspaceHost, harnessName } = o.run;
  const base = path.dirname(dataPath);
  const mappings: ResolvedMapping[] = [
    { host: launchPath, guest: GUEST.launch, readOnly: true },
    { host: dataPath, guest: GUEST.data, readOnly: false },
    { host: workspaceHost, guest: config.guestWorkspace, readOnly: config.readOnly },
  ];
  for (const m of config.mappings) {
    const host = expandPath(m.host, base);
    if (!dirExists(host)) {
      if (m.optional) { console.warn('Skipping optional mapping (folder not found): ' + host); continue; }
      fail('Required mapping folder not found: ' + host);
    }
    if (isRootPath(host) || isUserProfile(host)) fail('Refusing broad mapping: ' + host);
    mappings.push({ host, guest: m.guest, readOnly: m.readOnly });
  }
  const { probe } = o;
  if (probe.nodeDir) mappings.push({ host: probe.nodeDir, guest: GUEST.hostTools + '\\node', readOnly: true });
  if (probe.harnessExe && harnessName !== 'none') mappings.push({ host: probe.harnessExe.dir, guest: GUEST.hostTools + '\\agents\\' + harnessName, readOnly: true });
  if (probe.gitDir) mappings.push({ host: probe.gitDir, guest: GUEST.hostTools + '\\git', readOnly: true });
  if (probe.nvmDir) mappings.push({ host: probe.nvmDir, guest: GUEST.hostTools + '\\nvm', readOnly: true });
  assertNoGuestOverlap(mappings);
  return mappings;
};

/** Package hooks first, then ~/.agent-sandbox/hooks (same file name = user's wins), then --script / "scripts". */
const stageHooks = (packageRoot: string, launchPath: string, scripts: string[]): void => {
  for (const stage of HOOK_STAGES) {
    const target = path.join(launchPath, 'hooks', stage);
    ensureDir(target);
    for (const source of [path.join(packageRoot, 'hooks', stage), path.join(userDir(), 'hooks', stage)]) {
      if (dirExists(source)) fs.cpSync(source, target, { recursive: true, force: true });
    }
  }
  scripts.forEach((script: string, index: number) => {
    if (!fileExists(script)) fail('Script file not found: ' + script);
    fs.copyFileSync(script, path.join(launchPath, 'hooks', 'pre-agent', '90-extra-' + index + '-' + path.basename(script)));
  });
};

const copyRuntime = (packageRoot: string, launchPath: string): void => {
  const guestDir = path.join(packageRoot, 'dist', 'guest');
  if (!fileExists(path.join(guestDir, 'main.js'))) fail('Missing build output: ' + path.join(guestDir, 'main.js') + ' (run "npm run build").');
  ensureDir(path.join(launchPath, 'guest'));
  for (const file of fs.readdirSync(guestDir).filter((f: string) => f.endsWith('.js'))) fs.copyFileSync(path.join(guestDir, file), path.join(launchPath, 'guest', file));
  fs.writeFileSync(path.join(launchPath, 'guest', 'package.json'), '{ "type": "module" }\n', 'utf8');
  fs.cpSync(path.join(packageRoot, 'sandbox'), path.join(launchPath, 'sandbox'), { recursive: true });
};

export const generateSandbox = (o: GenerateOptions): Generated & { personalization: string } => {
  const { config, dataPath, workspaceHost, harnessName, storageRoot } = o.run;
  const harness = harnessName === 'none' ? null : config.harnesses[harnessName] ?? fail('Unknown harness: ' + harnessName);
  if (!dirExists(workspaceHost)) fail('Workspace folder does not exist: ' + workspaceHost);

  const launchId = Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const launchPath = path.join(storageRoot, 'launches', launchId);
  ensureDir(launchPath);
  ensureDir(dataPath);
  const mappings = collectMappings(o, launchPath);

  const profile: ProfileResult = harnessName === 'claude' ? stageClaudeProfile(config.claudeProfile, launchPath) : { hostDir: null, staged: [], skipped: [], credentials: false };
  const gitconfig = path.join(homeDir(), '.gitconfig');
  if (fileExists(gitconfig)) { ensureDir(path.join(launchPath, 'home')); fs.copyFileSync(gitconfig, path.join(launchPath, 'home', '.gitconfig')); }
  const personalization = config.personalization.enabled ? capturePersonalization(launchPath) : 'disabled';

  const session: GuestSession = {
    launchId,
    project: path.basename(workspaceHost),
    workspace: config.guestWorkspace,
    workspaceHost,
    harnessName,
    harness,
    harnessArguments: o.harnessArgs,
    persistAgentState: config.storage.persistAgentState,
    networking: config.sandbox.networking,
    headless: config.sandbox.headless,
    network: config.network,
    provisioning: config.provisioning,
    toolchains: config.toolchains,
    versions: o.run.versions,
    attach: config.attach,
    hooks: config.hooks,
    hostTools: { node: Boolean(o.probe.nodeDir), harnessExecutable: o.probe.harnessExe?.file ?? null, git: Boolean(o.probe.gitDir), nvm: Boolean(o.probe.nvmDir) },
    claudeProfile: { overwrite: config.claudeProfile.overwrite, items: profile.staged, credentials: profile.credentials, hostConfigDir: profile.hostDir ?? hostClaudeDir(config.claudeProfile), syncClaudeMem: config.claudeProfile.syncClaudeMem },
    personalization: fs.existsSync(path.join(launchPath, 'personalize', 'personalize.reg')),
  };
  const sessionPath = path.join(launchPath, 'session.json');
  writeJson(sessionPath, session);
  copyRuntime(o.packageRoot, launchPath);
  stageHooks(o.packageRoot, launchPath, o.run.scripts);

  const memoryMb = resolveMemoryMb(config.sandbox, o.freeMemoryBytes);
  const wsbPath = path.join(launchPath, 'agent.wsb');
  fs.writeFileSync(wsbPath, buildWsb(config, memoryMb, mappings), 'utf8');
  return { wsbPath, launchPath, launchId, sessionPath, memoryMb, mappings, profile, personalization };
};
