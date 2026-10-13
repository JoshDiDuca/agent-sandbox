// `launch` / `generate`, and what sandbox claude runs: start a sandbox, or another session in the running one. From a
// folder the running sandbox does not have yet, the folder joins it (no restart) when it can, and otherwise a
// restart that adds it is offered (restart.ts).
import path from 'node:path';
import { generateSandbox } from '../../../host/launch/index.js';
import { findSecretFiles } from '../../../host/profile/index.js';
import { RepoGuardStore } from '../../../host/guard/index.js';
import { assertCanLaunch, isSandboxRunning, spawnDetached, startSandbox } from '../../../host/sandbox/index.js';
import { probeHost } from '../../../host/sandbox/index.js';
import { KnownProjects, ProjectRegistry } from '../../../host/projects/index.js';
import { hideSandboxWindow } from '../../../host/sandbox/index.js';
import { isWithin } from '../../../shared/paths/index.js';
import { watcherRunning } from '../../../sync/index.js';
import { protectionsOf } from '../../../core/local-config/index.js';
import { errMsg } from '../../../core/util/index.js';
import { syncAgentCommands } from '../agent-commands.js';
import { askYesNo } from '../../../core/prompt.js';
import { resolveRun } from '../../../core/run/index.js';
import { c } from '../../output/index.js';
import { requireOnPc, type Context } from '../context.js';
import { table } from '../../output/index.js';
import _ from 'lodash';
import { LifeRecord } from '../../../host/life/index.js';
import { startIntoRunning, launchIntoRunning, contextFor, waitForBoot, attachHere, waitForStart } from './running.js';
import { maybeAddRoot } from './add-root.js';
import { prepare, firstBoot, FIRST_BOOT } from './prepare.js';

/** A restart that adds a project: map these too, start no session at boot (restart.ts opens them), wait until ready. */
export interface LaunchExtras {
  extraProjects?: string[];
  autoSession?: boolean;
  waitUntilReady?: boolean;
}

export const launch = async (ctx: Context, generateOnly = false, extras: LaunchExtras = {}): Promise<number> => {
  const { options, loaded, packageRoot, dataPath, storageRoot } = ctx;
  // attach.auto: an agent started from an interactive terminal attaches it, as with -t.
  if (loaded.config.attach.auto && !options.noAgent && process.stdin.isTTY && process.stdout.isTTY)
    options.terminal = true;
  if (!generateOnly) requireOnPc('launch');
  // agentCommands (Beta) follows the config: a setting changed in the file takes effect here too. Never blocks a launch.
  if (!generateOnly) {
    try {
      syncAgentCommands(ctx, loaded.config);
    } catch (e) {
      console.warn('Agent commands (Beta): ' + errMsg(e));
    }
  }
  if (!generateOnly && isSandboxRunning()) return options.noAgent ? startIntoRunning(ctx) : launchIntoRunning(ctx);
  // Several sessions: the sandbox starts from the first one's folder with the others' folders mapped too, then
  // they all open in it (each project is set up on demand, in parallel). One --session is an ordinary launch.
  const wants = options.sessions;
  if (wants.length === 1) return launch(contextFor(ctx, wants[0]), generateOnly, extras);
  if (wants.length > 1) {
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
    return generateOnly || started !== 0 ? started : launchIntoRunning(ctx);
  }
  const run = await resolveRun({
    packageRoot,
    loaded,
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
  const { config } = run;
  if (!generateOnly) assertCanLaunch();
  if (!generateOnly && !extras.extraProjects) await maybeAddRoot(ctx, run);
  const prepared = generateOnly ? null : await prepare(ctx, run);
  const generated = generateSandbox({
    packageRoot,
    run,
    harnessArgs: options.passthrough,
    probe: probeHost(config, run.harnessName),
    extraProjects: extras.extraProjects,
    autoSession: extras.autoSession,
  });

  for (const note of [...run.notes, ...generated.projects.notes]) console.log(note);
  const secretFiles = config.secrets.warnFiles ? findSecretFiles(run.workspaceHost) : [];
  if (secretFiles.length) {
    const shown = secretFiles.slice(0, 12).join(', ') + (secretFiles.length > 12 ? ', ...' : '');
    console.warn(
      c.yellow(
        'Heads-up: the agent can read these files in your workspace, which often hold secrets: ' +
          shown +
          '. Move real credentials out of the folder (or use test ones). Silence with secrets.warnFiles = false.',
      ),
    );
  }
  const { roots, projects } = generated.projects;
  table([
    ['Workspace', run.workspaceHost + '  ->  ' + config.guestWorkspace + (config.readOnly ? '  (read-only)' : '')],
    [
      'Agent',
      run.harnessName +
        (prepared?.account ? '  (account: ' + prepared.account + ')' : '') +
        '   Memory: ' +
        generated.memoryMb +
        ' MB   CPU: ' +
        (config.sandbox.cpuLimit === 'none' ? 'all' : 'max ' + config.sandbox.cpuLimit + '%') +
        '   Network: ' +
        config.sandbox.networking +
        (config.sandbox.headless ? '   HEADLESS' : ''),
    ],
    [
      'Node',
      run.versions.node.spec +
        ' (' +
        run.versions.node.source +
        ')   Python: ' +
        run.versions.python.spec +
        ' (' +
        run.versions.python.source +
        ')',
    ],
    ...(prepared
      ? [
          ['Ignored files', prepared.filter],
          ['Terminal', prepared.terminal],
          ['History', prepared.history],
          ['Cleanup', prepared.pruned],
        ]
      : []),
    [
      'Toolchains',
      Object.entries(generated.toolchains)
        .filter(([, d]) => d.on)
        .map(([name, d]) => name + ' (' + d.reason + ')')
        .join(', ') || 'Node only (nothing else used by this project)',
    ],
    ...(generated.databases.length
      ? generated.databases.map((d, i) => [
          i ? '' : 'Databases',
          d.database +
            (d.database === 'sqlserver'
              ? ' (cannot run in the sandbox; use Postgres or SQLite for local work)'
              : ' on port ' + d.port) +
            '  because ' +
            d.reasons[0] +
            (d.reasons.length > 1 ? ' (+' + (d.reasons.length - 1) + ' more)' : ''),
        ])
      : [['Databases', 'none needed (databases.<name>.enabled = true adds one)']]),
    ['Desktop', generated.personalization],
    [
      'Claude',
      generated.profile.staged.length
        ? generated.profile.staged.join(', ') + (generated.profile.credentials ? '  (INCLUDING YOUR LOGIN)' : '')
        : 'no settings copied',
    ],
    [
      'Secrets',
      !config.secrets.strip
        ? 'NOT stripped (secrets.strip is off)'
        : generated.profile.secretsRemoved.length
          ? 'kept on this PC: ' + generated.profile.secretsRemoved.join(', ') + '  (secrets.allow lets one through)'
          : 'none found in what is copied',
    ],
    ...roots.map((r, i) => [
      i ? '' : 'Project roots',
      r.host + '  ->  ' + r.guest + '  (every project in it opens without a restart)',
    ]),
    ...projects.map((p, i) => [i ? '' : 'Projects', p.host + '  ->  ' + p.guest]),
    ...generated.mappings
      .slice(3)
      .filter((m) => ![...roots, ...projects].some((p) => p.guest === m.guest))
      .map((m) => ['  map ' + (m.readOnly ? 'ro' : 'rw'), m.host + '  ->  ' + m.guest]),
    ['Generated', generated.wsbPath],
  ]);
  if (generateOnly) return 0;

  // Every folder the sandbox can write is snapshotted before it starts (the guard compares against this), and the
  // projects it starts with are recorded host-side for the commands that run later.
  new RepoGuardStore(dataPath).save(
    run.workspaceHost,
    projects.map((p) => p.host),
    roots.map((r) => r.host),
  );
  new ProjectRegistry(storageRoot).start({
    launchId: generated.launchId,
    protections: protectionsOf(config),
    primary: { host: run.workspaceHost, guest: config.guestWorkspace },
    roots,
    boot: projects,
  });
  new KnownProjects(storageRoot).remember(run.workspaceHost);
  new LifeRecord(storageRoot, dataPath).start(config.sandbox.keepAwake);
  startSandbox(generated.wsbPath);
  // Absolute: the watcher runs from another folder, and a relative --config there would make it exit silently.
  if (!watcherRunning(dataPath))
    spawnDetached(ctx.entry, ['_watch', ...(options.config ? ['--config', path.resolve(options.config)] : [])]);
  // Hiding runs alongside; a failure to find the window must never break the launch or an attach.
  const hidden = config.sandbox.headless ? hideSandboxWindow(storageRoot).catch(() => false) : null;
  if (options.terminal || options.noAgent || extras.waitUntilReady) {
    if (firstBoot(dataPath)) console.log(FIRST_BOOT);
    await waitForBoot(dataPath, generated.launchId);
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
  if (firstBoot(dataPath)) console.log(FIRST_BOOT);
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
};
