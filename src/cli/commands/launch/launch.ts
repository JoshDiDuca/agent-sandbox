// `launch` / `generate`, and what sandbox claude runs: start a sandbox, or another session in the running one. From a
// folder the running sandbox does not have yet, the folder joins it (no restart) when it can, and otherwise a
// restart that adds it is offered (restart.ts).
import path from 'node:path';
import _ from 'lodash';
import { generateSandbox } from '../../../host/launch/index.js';
import { findSecretFiles } from '../../../host/profile/index.js';
import { RepoGuardStore } from '../../../host/guard/index.js';
import {
  assertCanLaunch,
  isSandboxRunning,
  spawnDetached,
  startSandbox,
  probeHost,
  hideSandboxWindow,
} from '../../../host/sandbox/index.js';
import { KnownProjects, ProjectRegistry } from '../../../host/projects/index.js';
import { LifeRecord } from '../../../host/life/index.js';
import { isWithin } from '../../../shared/paths/index.js';
import { watcherRunning } from '../../../sync/index.js';
import { protectionsOf } from '../../../core/local-config/index.js';
import { errMsg } from '../../../core/util/index.js';
import { askYesNo } from '../../../core/prompt.js';
import { resolveRun } from '../../../core/run/index.js';
import type { ResolvedRun } from '../../../core/types.js';
import { c, table } from '../../output/index.js';
import { syncAgentCommands } from '../agent-commands.js';
import { requireOnPc, type Context } from '../context.js';
import { joinHere, type Relauncher } from '../projects/index.js';
import {
  startIntoRunning,
  launchIntoRunning,
  contextFor,
  waitForBoot,
  attachHere,
  waitForStart,
  openSession,
  readySandbox,
} from './running.js';
import { maybeAddRoot } from './add-root.js';
import { prepare, firstBootNotice } from './prepare.js';
import { bootWantsFor } from './boot-wants.js';
import { launchSummary, type GeneratedSandbox } from './summary.js';

/** A restart that adds a project: map these too, start no session at boot (restart.ts opens them), wait until ready. */
export interface LaunchExtras {
  readonly extraProjects?: string[];
  readonly autoSession?: boolean;
  readonly waitUntilReady?: boolean;
}

/** One launch (or `generate`): from the command line to a started sandbox, a session in it, or the written files. */
class Launcher {
  private readonly options: Context['options'];

  constructor(
    private readonly ctx: Context,
    private readonly generateOnly: boolean,
    private readonly extras: LaunchExtras,
  ) {
    this.options = ctx.options;
  }

  async run(): Promise<number> {
    const { options, generateOnly } = this;
    // attach.auto: an agent started from an interactive terminal attaches it, as with -t.
    if (this.ctx.loaded.config.attach.auto && !options.noAgent && process.stdin.isTTY && process.stdout.isTTY)
      options.terminal = true;
    if (!generateOnly) requireOnPc('launch');
    if (!generateOnly) this.syncAgentCommands();
    if (!generateOnly && isSandboxRunning())
      return options.noAgent ? startIntoRunning(this.ctx, RELAUNCHER) : launchIntoRunning(this.ctx, RELAUNCHER);
    if (options.sessions.length) return this.launchSessions();
    return this.launchHere();
  }

  /** agentCommands (Beta) follows the config: a setting changed in the file takes effect here too. Never blocks. */
  private syncAgentCommands(): void {
    try {
      syncAgentCommands(this.ctx, this.ctx.loaded.config);
    } catch (e) {
      console.warn('Agent commands (Beta): ' + errMsg(e));
    }
  }

  /**
   * Several sessions: the sandbox starts from the first one's folder with the others' folders mapped too, then they
   * all open in it (each project is set up on demand, in parallel). One --session is an ordinary launch.
   */
  private async launchSessions(): Promise<number> {
    const { ctx, generateOnly, extras } = this;
    const wants = this.options.sessions;
    if (wants.length === 1) return launch(contextFor(ctx, wants[0]), generateOnly, extras);
    const first = contextFor(ctx, wants[0]);
    const others = _.uniqBy(
      wants
        .slice(1)
        .map((w) => w.folder)
        .filter((f) => !isWithin(wants[0].folder, f)),
      (f) => f.toLowerCase(),
    );
    const started = await launch({ ...first, options: { ...first.options, terminal: false } }, generateOnly, {
      ...extras,
      extraProjects: [...(extras.extraProjects ?? []), ...others],
      autoSession: false,
      waitUntilReady: true,
    });
    return generateOnly || started !== 0 ? started : launchIntoRunning(ctx, RELAUNCHER);
  }

  private resolve(): Promise<ResolvedRun> {
    const { options } = this;
    return resolveRun({
      packageRoot: this.ctx.packageRoot,
      loaded: this.ctx.loaded,
      cwd: process.cwd(),
      workspace: options.workspace,
      harness: options.harness,
      noAgent: options.noAgent,
      noLocalConfig: options.noLocalConfig,
      trustConfig: options.trustConfig,
      scripts: options.scripts,
      databases: options.databases,
      headless: options.headless,
      nodeVersion: options.node,
      pythonVersion: options.python,
      ask: askYesNo,
    });
  }

  /** One sandbox for this folder: resolve, prepare, write the launch files, then (unless generate) start it. */
  private async launchHere(): Promise<number> {
    const { ctx, generateOnly, extras } = this;
    const run = await this.resolve();
    const { config } = run;
    if (!generateOnly) assertCanLaunch();
    if (!generateOnly && !extras.extraProjects) await maybeAddRoot(ctx, run);
    const prepared = generateOnly ? null : await prepare(ctx, run);
    const bootWants = await bootWantsFor(ctx, run, extras.extraProjects);
    const generated: GeneratedSandbox = generateSandbox({
      packageRoot: ctx.packageRoot,
      run,
      harnessArgs: this.options.passthrough,
      probe: probeHost(config, run.harnessName),
      extraProjects: extras.extraProjects,
      autoSession: extras.autoSession,
      bootWants: bootWants.wants,
    });

    const notes = [...run.notes, ...bootWants.notes, ...generated.projects.notes, ...generated.mappingNotes];
    for (const note of notes) console.log(note);
    this.warnSecretFiles(run);
    table(launchSummary(run, generated, prepared));
    if (generateOnly) return 0;
    this.record(run, generated);
    startSandbox(generated.wsbPath);
    this.startWatcher();
    return this.afterStart(run, generated);
  }

  private warnSecretFiles(run: ResolvedRun): void {
    const secretFiles = run.config.secrets.warnFiles ? findSecretFiles(run.workspaceHost) : [];
    if (!secretFiles.length) return;
    const shown = secretFiles.slice(0, 12).join(', ') + (secretFiles.length > 12 ? ', ...' : '');
    console.warn(
      c.yellow(
        'Heads-up: the agent can read these files in your workspace, which often hold secrets: ' +
          shown +
          '. Move real credentials out of the folder (or use test ones). Silence with secrets.warnFiles = false.',
      ),
    );
  }

  /**
   * Every folder the sandbox can write is snapshotted before it starts (the guard compares against this), and the
   * projects it starts with are recorded host-side for the commands that run later.
   */
  private record(run: ResolvedRun, generated: GeneratedSandbox): void {
    const { dataPath, storageRoot } = this.ctx;
    const { config } = run;
    const { roots, projects } = generated.projects;
    new RepoGuardStore(dataPath).save(
      run.workspaceHost,
      projects.map((p) => p.host),
      roots.map((r) => r.host),
    );
    new ProjectRegistry(storageRoot).start({
      launchId: generated.launchId,
      protections: protectionsOf(generated.bootConfig),
      primary: { host: run.workspaceHost, guest: config.guestWorkspace },
      roots,
      boot: projects,
      atBoot: { memoryMb: generated.memoryMb, mappings: generated.mappings, widened: generated.widened },
    });
    new KnownProjects(storageRoot).remember(run.workspaceHost);
    new LifeRecord(storageRoot, dataPath).start(config.sandbox.keepAwake);
  }

  /** Absolute: the watcher runs from another folder, and a relative --config there would make it exit silently. */
  private startWatcher(): void {
    const { config } = this.options;
    if (!watcherRunning(this.ctx.dataPath))
      spawnDetached(this.ctx.entry, ['_watch', ...(config ? ['--config', path.resolve(config)] : [])]);
  }

  /** Waits for the boot and attaches when asked to; otherwise says where the agent opens. */
  private async afterStart(run: ResolvedRun, generated: GeneratedSandbox): Promise<number> {
    const { ctx, options, extras } = this;
    const { dataPath, storageRoot } = ctx;
    const { config } = run;
    // Hiding runs alongside; a failure to find the window must never break the launch or an attach.
    const hidden = config.sandbox.headless ? hideSandboxWindow(storageRoot).catch(() => false) : null;
    const headsUp = firstBootNotice(dataPath, generated);
    if (options.terminal || options.noAgent || extras.waitUntilReady) {
      if (headsUp) console.log(headsUp);
      await waitForBoot(dataPath, generated.launchId, Boolean(headsUp));
      if (extras.waitUntilReady) return 0;
      // Without an agent there is no session to attach to: the sandbox itself is the result.
      if (options.noAgent) {
        console.log(
          'Sandbox ready. Its window has a terminal in ' +
            config.guestWorkspace +
            '; from here: sandbox exec -- <command>, sandbox stop.',
        );
        return 0;
      }
      return attachHere(ctx, await waitForStart(ctx, generated.launchId, 'Starting ' + run.harnessName));
    }
    if (headsUp) console.log(headsUp + '\nFollow along: sandbox logs -f');
    if (hidden)
      console.log(
        (await hidden)
          ? 'Sandbox running headless. Open the window: sbx-show   Attach here: sandbox claude -t'
          : 'Could not find the sandbox window to hide (it may still be starting); run sandbox hide in a moment.',
      );
    else
      console.log(
        'Sandbox starting. ' +
          run.harnessName +
          ' opens in Windows Terminal inside it. Attach here any time: sandbox claude -t',
      );
    return 0;
  }
}

export function launch(ctx: Context, generateOnly = false, extras: LaunchExtras = {}): Promise<number> {
  return new Launcher(ctx, generateOnly, extras).run();
}

/** What a restart (restart.ts) uses to start the sandbox again and reopen its sessions. */
const RELAUNCHER: Relauncher = { launch, readySandbox, joinHere, openSession };
