// Writes a launch folder for one sandbox: session.json (what the guest needs to know), the bundled runtime, hooks, the
// staged Claude settings and the .wsb file that starts Windows Sandbox. The pieces live in the sibling files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { GenerateOptions, Generated, ProfileResult } from '../../core/types.js';
import { dirExists, ensureDir, fail, writeJson } from '../../core/util/index.js';
import { capturePersonalization, stageClaudeProfile } from '../profile/index.js';
import { assertTestWritable } from '../test-guard.js';
import { planBootProjects } from './boot-projects.js';
import { planDatabases } from './database-plan.js';
import { collectMappings } from './mappings.js';
import { guestSession, logonEnv } from './session-file.js';
import { copyRuntime, stageGitIdentity, stageHooks } from './stage.js';
import { decideProjectToolchains } from './toolchains.js';
import { buildWsb, resolveMemoryMb } from './wsb-file.js';

const NO_PROFILE: ProfileResult = { hostDir: null, staged: [], skipped: [], credentials: false, secretsRemoved: [] };

export function generateSandbox(o: GenerateOptions): Generated & { personalization: string } {
  const { config, dataPath, workspaceHost, harnessName, storageRoot } = o.run;
  const harness =
    harnessName === 'none'
      ? null
      : (config.harnesses[harnessName] ??
        fail('Unknown agent: ' + harnessName, 'Configured agents: ' + Object.keys(config.harnesses).join(', ')));
  if (!dirExists(workspaceHost))
    fail('The workspace folder does not exist: ' + workspaceHost, 'cd into the project first.');
  assertTestWritable(storageRoot);
  assertTestWritable(dataPath);

  // Checked before anything is written, so a refusal leaves nothing behind.
  const memoryMb = resolveMemoryMb(config.sandbox, o.freeMemoryBytes);
  const launchId = Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const launchPath = path.join(storageRoot, 'launches', launchId);
  ensureDir(launchPath);
  ensureDir(dataPath);
  const boot = planBootProjects({
    run: o.run,
    packageRoot: o.packageRoot,
    extraProjects: o.extraProjects,
    knownProjects: o.knownProjects,
  });
  const mappings = collectMappings(o, launchPath, boot);

  const profile =
    harnessName === 'claude'
      ? stageClaudeProfile(config.claudeProfile, launchPath, workspaceHost, config.secrets)
      : NO_PROFILE;
  stageGitIdentity(launchPath);
  const personalization = config.personalization.enabled ? capturePersonalization(launchPath) : 'disabled';
  const databases = o.databases ?? planDatabases(config.databases, workspaceHost);
  const toolchains = decideProjectToolchains(o);

  const session = guestSession(o, { launchId, launchPath, harness, boot, mappings, profile, databases, toolchains });
  const sessionPath = path.join(launchPath, 'session.json');
  writeJson(sessionPath, session);
  fs.writeFileSync(path.join(launchPath, 'env.cmd'), logonEnv(session.workspace), 'utf8');
  copyRuntime(o.packageRoot, launchPath);
  stageHooks(o.packageRoot, launchPath, o.run.scripts);

  const wsbPath = path.join(launchPath, 'agent.wsb');
  fs.writeFileSync(wsbPath, buildWsb(config, memoryMb, mappings), 'utf8');
  return {
    wsbPath,
    launchPath,
    launchId,
    sessionPath,
    memoryMb,
    mappings,
    profile,
    personalization,
    databases,
    toolchains,
    projects: boot,
  };
}
