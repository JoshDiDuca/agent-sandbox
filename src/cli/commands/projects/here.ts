// Which project of the running sandbox a command is run from. Every command that works on a running sandbox uses
// these, so they all agree: `locateHere` only looks (attach, sessions, status, restart), `joinHere` also makes the
// folder a project of the running sandbox when it can without a restart (launch, start, exec, db).
import path from 'node:path';
import { select } from '@inquirer/prompts';
import type { SandboxStatus } from '../../../core/types.js';
import { describeMissing, missingTip, type Missing } from '../../../core/local-config/index.js';
import { askYesNo } from '../../../core/prompt.js';
import { isInsideOrEqual } from '../../../core/util/index.js';
import { resolveRun } from '../../../core/run/index.js';
import { SandboxChannel } from '../../../host/channel/index.js';
import { ProjectRegistry, type RegistryEntry, joinRunning, type MissingChoice } from '../../../host/projects/index.js';
import type { ProjectSpec } from '../../../shared/channel/index.js';
import { c, working } from '../../output/index.js';
import { describeSessions } from './describe-sessions.js';
import { guestPathFor, type Context } from '../context.js';

/** The folder the command is about: --workspace, else the current one. */
export function hereDir(ctx: Context): string {
  return path.resolve(ctx.options.workspace ?? process.cwd());
}

export interface Located {
  project: RegistryEntry | null;
  guestDir: string | null;
}

/** Where this folder is in the running sandbox, if it is in it at all (nothing is registered). */
export function locateHere(ctx: Context, status: SandboxStatus | null): Located {
  const dir = hereDir(ctx);
  const here = new ProjectRegistry(ctx.storageRoot).here(dir);
  if (here) return here;
  // A sandbox started before projects existed: only its launch folder.
  if (!new ProjectRegistry(ctx.storageRoot).read() && status && isInsideOrEqual(status.workspaceHost, dir))
    return { project: null, guestDir: guestPathFor(dir, status.workspaceHost, status.guestWorkspace) };
  return { project: null, guestDir: null };
}

export interface Joined {
  project: RegistryEntry | null;
  guestDir: string;
  spec: ProjectSpec | null;
  harness: string | null;
  notes: string[];
}

let restartedOnce = false;

/** restart.ts: the sandbox was restarted for a project in this command. */
export function markRestarted(): void {
  restartedOnce = true;
}

/**
 * Makes this folder a project of the running sandbox (nothing to do for the launch folder and projects already in
 * it): its .sandbox-config.json is approved like at a launch, its protections are checked, and it is made visible.
 * Throws NeedsRestart (host/projects) when that is impossible without a restart.
 */
export async function joinHere(ctx: Context, status: SandboxStatus, o: { noRestart?: boolean } = {}): Promise<Joined> {
  const { options, loaded, packageRoot, storageRoot, dataPath } = ctx;
  const dir = hereDir(ctx);
  // A sandbox started before projects existed: only its launch folder (guestPathFor explains why otherwise).
  if (!new ProjectRegistry(storageRoot).read())
    return {
      project: null,
      guestDir: guestPathFor(dir, status.workspaceHost, status.guestWorkspace),
      spec: null,
      harness: null,
      notes: [],
    };
  let shown = false;
  const joined = await joinRunning({
    storageRoot,
    dataPath,
    packageRoot,
    hostDir: dir,
    wsbShare: loaded.config.projects.wsbShare,
    resolve: (root) =>
      resolveRun({
        packageRoot,
        loaded,
        cwd: root,
        workspace: root,
        harness: options.harness,
        noAgent: options.noAgent,
        noLocalConfig: options.noLocalConfig,
        trustConfig: options.trustConfig,
        scripts: options.scripts,
        databases: options.databases,
        nodeVersion: options.node,
        pythonVersion: options.python,
        ask: askYesNo,
      }),
    // Something it wants only comes with a restart: --yes restarts, a terminal asks, anything else continues.
    decide: async (name, missing): Promise<MissingChoice> => {
      // Once per command: what a restart could not give (see the launch notes) never restarts it again.
      if (o.noRestart || restartedOnce) return 'continue';
      if (options.yes) return 'restart';
      if (!process.stdin.isTTY || !process.stdout.isTTY) return 'continue';
      console.log(c.yellow(describeMissing(name, missing)));
      shown = true;
      const sessions = new SandboxChannel(dataPath).currentSessions();
      const ending = sessions.length ? describeSessions(sessions) + ' will end' : 'no session is running';
      return select<MissingChoice>({
        message: 'What now?',
        choices: [
          { name: 'Continue anyway (join without them)', value: 'continue' },
          { name: 'Restart with them (' + ending + ')', value: 'restart' },
          { name: 'Cancel', value: 'cancel' },
        ],
        default: 'continue',
      });
    },
  });
  const harness = joined.run && joined.run.harnessName !== 'none' ? joined.run.harnessName : null;
  const notes = joined.missing
    ? [...joined.notes, ...missingNotes(ctx, joined.project.name, joined.project.host, joined.missing, shown)]
    : joined.notes;
  return { project: joined.project, guestDir: joined.guestDir, spec: joined.spec, harness, notes };
}

/** The command that restarts the running sandbox with this folder's boot wishes (consent given by --yes). */
export function restartCommand(ctx: Context, host: string): string {
  const agent = ctx.options.noAgent ? 'start' : (ctx.options.harness ?? ctx.loaded.config.defaultHarness);
  return 'sandbox ' + agent + ' --workspace "' + host + '" --yes';
}

/** Joined without what it wants at boot: what is missing, how to restart with it, and how to always have it. */
export function missingNotes(ctx: Context, name: string, host: string, missing: Missing, shown = false): string[] {
  return [
    ...(shown ? [] : [c.yellow(describeMissing(name, missing))]),
    'Joined without them. To restart the sandbox with them (its sessions end): ' + restartCommand(ctx, host),
    c.dim(missingTip(missing)),
  ];
}

/** Waits until the sandbox has set a project up, with its progress on a spinner (plain lines without a terminal). */
export async function provisionJoined(ctx: Context, joined: Joined): Promise<void> {
  if (!joined.spec) return;
  const spec = joined.spec;
  let step = 'starting';
  await working(
    () => 'Setting up ' + spec.name + ' in the running sandbox: ' + step,
    () =>
      new SandboxChannel(ctx.dataPath).prepareProject(spec, (m) => {
        step = m;
      }),
  );
}

/** joinHere, then (for another project) waits until the sandbox has set it up. */
export async function readyHere(ctx: Context, status: SandboxStatus): Promise<Joined> {
  const joined = await joinHere(ctx, status);
  for (const note of joined.notes) console.log(note);
  await provisionJoined(ctx, joined);
  return joined;
}
