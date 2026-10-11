import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config, GenerateOptions, Generated, GuestSession, ProfileResult, ResolvedMapping } from '../core/types.js';
import { assertNoGuestOverlap, userDir } from '../core/config.js';
import { capturePersonalization } from './personalize.js';
import { assertSafeMapping } from '../core/workspace.js';
import { hostClaudeDir, stageClaudeProfile } from './claude-profile.js';
import { decideToolchains, resolveToolchains } from '../core/detect-toolchains.js';
import { pcLanguages, planDatabases, projectEntries } from './project-scan.js';
import { dirExists, ensureDir, fail, fileExists, homeDir, writeJson, xmlEscape } from '../core/util.js';

export const GUEST = { launch: 'C:\\AgentLaunch', data: 'C:\\AgentData', hostTools: 'C:\\HostTools' } as const;
const HOOK_STAGES = ['pre-provision', 'pre-agent', 'post-agent'];
const toggle = (value: boolean): string => (value ? 'Enable' : 'Disable');

export const resolveMemoryMb = (sandbox: Config['sandbox'], freeMemoryBytes = os.freemem()): number => {
  if (sandbox.memoryMb !== 'auto') return sandbox.memoryMb;
  const freeMb = Math.floor(freeMemoryBytes / 1048576);
  const rounded = Math.floor(Math.min(sandbox.maxMemoryMb, freeMb - sandbox.reserveHostMb) / 1024) * 1024;
  if (rounded < 4096) fail('Not enough free RAM for the sandbox (' + freeMb + ' MB free, ' + sandbox.reserveHostMb + ' MB kept for this PC).', 'Close some apps, lower sandbox.reserveHostMb, or set sandbox.memoryMb to a fixed value (>= 4096).');
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
  const mappings: ResolvedMapping[] = [
    { host: launchPath, guest: GUEST.launch, readOnly: true },
    { host: dataPath, guest: GUEST.data, readOnly: false },
    { host: workspaceHost, guest: config.guestWorkspace, readOnly: config.readOnly },
  ];
  for (const m of config.mappings) {
    const host = m.host;
    if (!dirExists(host)) {
      if (m.optional) { console.warn('Skipping optional mapping (folder not found): ' + host); continue; }
      fail('A mapped folder does not exist: ' + host, 'Create it, fix the path in your config, or mark the mapping "optional": true.');
    }
    assertSafeMapping(host, o.packageRoot, o.run.storageRoot);
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
    if (!fileExists(script)) fail('Script file not found: ' + script, 'Check the --script path.');
    fs.copyFileSync(script, path.join(launchPath, 'hooks', 'pre-agent', '90-extra-' + index + '-' + path.basename(script)));
  });
};

export const RUNTIME_FILES = ['main.js', 'daemon.js', 'view.js', 'gitguard.js'];

/** The bundled sandbox runtime (dist/runtime: one self-contained file per entry point) and the sandbox/ scripts. */
const copyRuntime = (packageRoot: string, launchPath: string): void => {
  const runtime = path.join(packageRoot, 'dist', 'runtime');
  const missing = RUNTIME_FILES.filter((f) => !fileExists(path.join(runtime, f)));
  if (missing.length) fail('The sandbox runtime is missing from ' + runtime + ' (' + missing.join(', ') + ').', 'Rebuild it: npm run build (or reinstall the package).');
  ensureDir(path.join(launchPath, 'runtime'));
  for (const file of RUNTIME_FILES) fs.copyFileSync(path.join(runtime, file), path.join(launchPath, 'runtime', file));
  fs.writeFileSync(path.join(launchPath, 'package.json'), '{ "type": "module" }\n', 'utf8');
  fs.cpSync(path.join(packageRoot, 'sandbox'), path.join(launchPath, 'sandbox'), { recursive: true });
};

/** Only the identity from ~/.gitconfig: the rest can hold credentials (helpers, tokens in insteadOf URLs). */
export const gitIdentity = (gitconfig: string): string => {
  const values: Record<string, string> = {};
  let section = '';
  for (const line of gitconfig.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) { section = header[1].trim().toLowerCase(); continue; }
    const pair = /^\s*(name|email)\s*=\s*(.*?)\s*$/i.exec(line);
    if (section === 'user' && pair && !/[\r\n]/.test(pair[2])) values[pair[1].toLowerCase()] = pair[2].replace(/^"(.*)"$/, '$1');
  }
  const lines = Object.entries(values).map(([k, v]) => '\t' + k + ' = ' + v);
  return lines.length ? '[user]\n' + lines.join('\n') + '\n' : '';
};

export const generateSandbox = (o: GenerateOptions): Generated & { personalization: string } => {
  const { config, dataPath, workspaceHost, harnessName, storageRoot } = o.run;
  const harness = harnessName === 'none' ? null : config.harnesses[harnessName] ?? fail('Unknown agent: ' + harnessName, 'Configured agents: ' + Object.keys(config.harnesses).join(', '));
  if (!dirExists(workspaceHost)) fail('The workspace folder does not exist: ' + workspaceHost, 'cd into the project first.');

  // Checked before anything is written, so a refusal leaves nothing behind.
  const memoryMb = resolveMemoryMb(config.sandbox, o.freeMemoryBytes);
  const launchId = Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const launchPath = path.join(storageRoot, 'launches', launchId);
  ensureDir(launchPath);
  ensureDir(dataPath);
  const mappings = collectMappings(o, launchPath);

  const profile: ProfileResult = harnessName === 'claude' ? stageClaudeProfile(config.claudeProfile, launchPath, workspaceHost, config.secrets) : { hostDir: null, staged: [], skipped: [], credentials: false, secretsRemoved: [] };
  const gitconfig = path.join(homeDir(), '.gitconfig');
  const identity = fileExists(gitconfig) ? gitIdentity(fs.readFileSync(gitconfig, 'utf8')) : '';
  if (identity) { ensureDir(path.join(launchPath, 'home')); fs.writeFileSync(path.join(launchPath, 'home', '.gitconfig'), identity, 'utf8'); }
  const personalization = config.personalization.enabled ? capturePersonalization(launchPath) : 'disabled';
  const databases = o.databases ?? planDatabases(config.databases, workspaceHost);
  const toolchainDecisions = decideToolchains(config.toolchains, projectEntries(workspaceHost), o.pcLanguages ?? pcLanguages());

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
    // "auto" is decided here, so the guest and the launch table agree.
    toolchains: resolveToolchains(config.toolchains, toolchainDecisions),
    databases,
    versions: o.run.versions,
    attach: config.attach,
    hooks: config.hooks,
    hostTools: { node: Boolean(o.probe.nodeDir), nodeVersion: o.probe.nodeDir || o.probe.nvmNode ? o.probe.hostNodeVersion.replace(/^v/, '') : null, harnessExecutable: o.probe.harnessExe?.file ?? null, git: Boolean(o.probe.gitDir), nvm: Boolean(o.probe.nvmDir), volta: Boolean(o.probe.volta), pyenv: Boolean(o.probe.pyenv) },
    claudeProfile: { overwrite: config.claudeProfile.overwrite, items: profile.staged, credentials: profile.credentials, hostConfigDir: profile.hostDir ?? hostClaudeDir(config.claudeProfile), syncClaudeMem: config.claudeProfile.syncClaudeMem },
    personalization: fs.existsSync(path.join(launchPath, 'personalize', 'personalize.reg')),
  };
  const sessionPath = path.join(launchPath, 'session.json');
  writeJson(sessionPath, session);
  copyRuntime(o.packageRoot, launchPath);
  stageHooks(o.packageRoot, launchPath, o.run.scripts);

  const wsbPath = path.join(launchPath, 'agent.wsb');
  fs.writeFileSync(wsbPath, buildWsb(config, memoryMb, mappings), 'utf8');
  return { wsbPath, launchPath, launchId, sessionPath, memoryMb, mappings, profile, personalization, databases, toolchains: toolchainDecisions };
};
