// Which project of the running sandbox a command is run from. Every command that works on a running sandbox uses
// these, so they all agree: `locateHere` only looks (attach, sessions, status, restart), `joinHere` also makes the
// folder a project of the running sandbox when it can without a restart (launch, start, exec, db).
import path from 'node:path';
import type { SandboxStatus } from '../../core/types.js';
import { askYesNo } from '../../core/prompt.js';
import { isInsideOrEqual } from '../../core/util.js';
import { resolveRun } from '../../core/workspace.js';
import { prepareProject } from '../../host/channel.js';
import { projectHere, readRegistry, type RegistryEntry } from '../../host/projects.js';
import { joinRunning } from '../../host/join.js';
import type { ProjectSpecT } from '../../shared/schema.js';
import { working } from '../progress.js';
import { guestPathFor, sandboxAlive, type Context } from './context.js';

/** The folder the command is about: --workspace, else the current one. */
export const hereDir = (ctx: Context): string => path.resolve(ctx.options.workspace ?? process.cwd());

export interface Located { project: RegistryEntry | null; guestDir: string | null }

/** Where this folder is in the running sandbox, if it is in it at all (nothing is registered). */
export const locateHere = (ctx: Context, status: SandboxStatus | null): Located => {
  const dir = hereDir(ctx);
  const here = projectHere(ctx.storageRoot, dir);
  if (here) return here;
  // A sandbox started before projects existed: only its launch folder.
  if (!readRegistry(ctx.storageRoot) && status && isInsideOrEqual(status.workspaceHost, dir)) return { project: null, guestDir: guestPathFor(dir, status.workspaceHost, status.guestWorkspace) };
  return { project: null, guestDir: null };
};

export interface Joined { project: RegistryEntry | null; guestDir: string; spec: ProjectSpecT | null; harness: string | null; notes: string[] }

/**
 * Makes this folder a project of the running sandbox (nothing to do for the launch folder and projects already in
 * it): its .sandbox-config.json is approved like at a launch, its protections are checked, and it is made visible.
 * Throws NeedsRestart (host/projects.ts) when that is impossible without a restart.
 */
export const joinHere = async (ctx: Context, status: SandboxStatus): Promise<Joined> => {
  const { options, loaded, packageRoot, storageRoot, dataPath } = ctx;
  const dir = hereDir(ctx);
  // A sandbox started before projects existed: only its launch folder (guestPathFor explains why otherwise).
  if (!readRegistry(storageRoot)) return { project: null, guestDir: guestPathFor(dir, status.workspaceHost, status.guestWorkspace), spec: null, harness: null, notes: [] };
  const joined = await joinRunning({
    storageRoot, dataPath, packageRoot, hostDir: dir, wsbShare: loaded.config.projects.wsbShare,
    resolve: (root) => resolveRun({
      packageRoot, loaded, cwd: root, workspace: root, harness: options.harness, noAgent: options.noAgent,
      noLocalConfig: options.noLocalConfig, trustConfig: options.trustConfig, scripts: options.scripts, databases: options.databases,
      nodeVersion: options.node, pythonVersion: options.python, ask: askYesNo,
    }),
  });
  const harness = joined.run && joined.run.harnessName !== 'none' ? joined.run.harnessName : null;
  return { project: joined.project, guestDir: joined.guestDir, spec: joined.spec, harness, notes: joined.notes };
};

/** Waits until the sandbox has set a project up, with its progress on a spinner (plain lines without a terminal). */
export const provisionJoined = async (ctx: Context, joined: Joined): Promise<void> => {
  if (!joined.spec) return;
  const spec = joined.spec;
  let step = 'starting';
  await working(() => 'Setting up ' + spec.name + ' in the running sandbox: ' + step, () => prepareProject(ctx.dataPath, spec, sandboxAlive, (m) => { step = m; }));
};

/** joinHere, then (for another project) waits until the sandbox has set it up. */
export const readyHere = async (ctx: Context, status: SandboxStatus): Promise<Joined> => {
  const joined = await joinHere(ctx, status);
  for (const note of joined.notes) console.log(note);
  await provisionJoined(ctx, joined);
  return joined;
};
