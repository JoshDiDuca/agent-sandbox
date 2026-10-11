// Writes a launch folder for one sandbox: session.json (what the guest needs to know), the bundled runtime, hooks, the
// staged Claude settings and the .wsb file that starts Windows Sandbox. The pieces live in launch/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { GenerateOptions, Generated, GuestSession, HostProbe, ProfileResult } from '../core/types.js';
import { decideToolchains, resolveToolchains } from '../core/detect-toolchains.js';
import { readPwshScripts, usesPwsh } from '../core/detect-pwsh.js';
import { dirExists, ensureDir, fail, writeJson } from '../core/util.js';
import { substDrives } from '../shared/guest-paths.js';
import { PROJECTS_GUEST, hubName } from '../shared/projects.js';
import { planBootProjects } from './launch/projects.js';
import { hostClaudeDir, stageClaudeProfile } from './claude-profile.js';
import { databaseCatalog, planDatabases } from './database-plan.js';
import { collectMappings } from './launch/mappings.js';
import { copyRuntime, stageGitIdentity, stageHooks } from './launch/stage.js';
import { buildWsb, resolveMemoryMb } from './launch/wsb.js';
import { capturePersonalization } from './personalize.js';
import { pcLanguages } from './pc-scan.js';
import { msvcHint, projectEntries } from './project-scan.js';
import { assertTestWritable } from './test-guard.js';

const NO_PROFILE: ProfileResult = { hostDir: null, staged: [], skipped: [], credentials: false, secretsRemoved: [] };

/** Which toolchains the project needs ("auto" settings follow the project's files and what this PC has). */
export const decideProjectToolchains = (o: Pick<GenerateOptions, 'run' | 'pcLanguages'>): ReturnType<typeof decideToolchains> => {
  const { config, workspaceHost } = o.run;
  const msvcScript = config.toolchains.msvc.enabled === 'auto' ? msvcHint(workspaceHost) : undefined;
  const pwshScript = config.toolchains.pwsh.enabled === 'auto' ? usesPwsh(readPwshScripts(workspaceHost)) : null;
  const hints = { ...(msvcScript ? { msvc: msvcScript } : {}), ...(pwshScript ? { pwsh: pwshScript } : {}) };
  return decideToolchains(config.toolchains, projectEntries(workspaceHost), o.pcLanguages ?? pcLanguages(), hints);
};

/** What was found on this PC to copy instead of download. */
const hostToolsOf = (probe: HostProbe): GuestSession['hostTools'] => ({
  node: Boolean(probe.nodeDir),
  nodeVersion: probe.nodeDir || probe.nvmNode ? probe.hostNodeVersion.replace(/^v/, '') : null,
  harnessExecutable: probe.harnessExe?.file ?? null,
  git: Boolean(probe.gitDir),
  nvm: Boolean(probe.nvmDir),
  volta: Boolean(probe.volta),
  pyenv: Boolean(probe.pyenv),
});

export const generateSandbox = (o: GenerateOptions): Generated & { personalization: string } => {
  const { config, dataPath, workspaceHost, harnessName, storageRoot } = o.run;
  const harness = harnessName === 'none' ? null : config.harnesses[harnessName] ?? fail('Unknown agent: ' + harnessName, 'Configured agents: ' + Object.keys(config.harnesses).join(', '));
  if (!dirExists(workspaceHost)) fail('The workspace folder does not exist: ' + workspaceHost, 'cd into the project first.');
  assertTestWritable(storageRoot);
  assertTestWritable(dataPath);

  // Checked before anything is written, so a refusal leaves nothing behind.
  const memoryMb = resolveMemoryMb(config.sandbox, o.freeMemoryBytes);
  const launchId = Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const launchPath = path.join(storageRoot, 'launches', launchId);
  ensureDir(launchPath);
  ensureDir(dataPath);
  const boot = planBootProjects({ run: o.run, packageRoot: o.packageRoot, extraProjects: o.extraProjects, knownProjects: o.knownProjects });
  const mappings = collectMappings(o, launchPath, boot);

  const profile = harnessName === 'claude' ? stageClaudeProfile(config.claudeProfile, launchPath, workspaceHost, config.secrets) : NO_PROFILE;
  stageGitIdentity(launchPath);
  const personalization = config.personalization.enabled ? capturePersonalization(launchPath) : 'disabled';
  const databases = o.databases ?? planDatabases(config.databases, workspaceHost);
  const toolchainDecisions = decideProjectToolchains(o);

  const session: GuestSession = {
    launchId,
    project: path.basename(workspaceHost),
    projectId: hubName(workspaceHost, []),
    workspace: config.guestWorkspace,
    workspaceHost,
    projectsDir: PROJECTS_GUEST,
    roots: boot.roots.map((r) => r.guest),
    ...(o.autoSession === false ? { autoSession: false } : {}),
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
    databaseCatalog: databaseCatalog(config.databases),
    versions: o.run.versions,
    attach: config.attach,
    hooks: config.hooks,
    downloads: config.downloads,
    hostTools: hostToolsOf(o.probe),
    claudeProfile: { overwrite: config.claudeProfile.overwrite, items: profile.staged, credentials: profile.credentials, hostConfigDir: profile.hostDir ?? hostClaudeDir(config.claudeProfile), syncClaudeMem: config.claudeProfile.syncClaudeMem },
    personalization: fs.existsSync(path.join(launchPath, 'personalize', 'personalize.reg')),
    substDrives: substDrives(mappings.map((m) => m.guest)),
    cpuLimitPercent: config.sandbox.cpuLimit === 'none' ? null : config.sandbox.cpuLimit,
  };
  const sessionPath = path.join(launchPath, 'session.json');
  writeJson(sessionPath, session);
  copyRuntime(o.packageRoot, launchPath);
  stageHooks(o.packageRoot, launchPath, o.run.scripts);

  const wsbPath = path.join(launchPath, 'agent.wsb');
  fs.writeFileSync(wsbPath, buildWsb(config, memoryMb, mappings), 'utf8');
  return { wsbPath, launchPath, launchId, sessionPath, memoryMb, mappings, profile, personalization, databases, toolchains: toolchainDecisions, projects: boot };
};
