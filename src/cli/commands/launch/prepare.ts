import path from 'node:path';
import fs from 'node:fs';
import { AccountStore } from '../../../host/profile/index.js';
import { SandboxChannel } from '../../../host/channel/index.js';
import { describePrune, pruneStorage } from '../../../host/storage/index.js';
import { checkRepo } from '../../../host/guard/index.js';
import { ensureConpty } from '../../../host/tools/index.js';
import { ensureTerminal } from '../../../host/tools/index.js';
import { planView, viewSkipped } from '../../../host/workspace-view/index.js';
import { saveActiveViews } from '../../../host/workspace-view/index.js';
import { WorkspaceView } from '../../../host/workspace-view/index.js';
import { saveForwards } from '../../../host/network/index.js';
import { saveAuditSettings } from '../../../host/audit/collect.js';
import { readDataSize, saveMarkedProjects } from '../../../host/guard/index.js';
import { humanBytes } from '../../../core/disk.js';
import { syncBeforeLaunch } from '../../../sync/index.js';
import { watcherRunning } from '../../../sync/index.js';
import type { Config, ResolvedRun } from '../../../core/types.js';
import { errMsg } from '../../../core/util/index.js';
import { c } from '../../output/index.js';
import { working } from '../../output/index.js';
import { type Context } from '../context.js';
import { LifeRecord } from '../../../host/life/index.js';
import { UPDATE_RESTART_WARNING, updateRestartPending } from '../../../host/life/index.js';

/** Nothing has been installed into this data set yet: the first start downloads every toolchain once. */
export const firstBoot = (dataPath: string): boolean =>
  !fs.existsSync(path.join(dataPath, 'tools', 'resolved-versions.json'));
export const FIRST_BOOT =
  'First start for this storage: the sandbox downloads and installs the toolchains, databases and agent this project needs.\n' +
  'That takes a few minutes, once. Everything is kept, so every later start reuses it and takes seconds.';

const syncSummary = (config: Config, dataPath: string, workspaceHost: string): string => {
  try {
    const s = syncBeforeLaunch(config, dataPath, workspaceHost);
    return s.history + ' file(s) of history in, claude-mem ' + s.claudeMem;
  } catch (e) {
    return 'FAILED: ' + errMsg(e);
  }
};

/**
 * workspaceFilter: brings the project's filtered view in step before the sandbox maps it, and tells the background
 * watcher to keep it in step while the sandbox runs. Returns the line for the launch table.
 */
const prepareWorkspaceView = async (ctx: Context, run: ResolvedRun): Promise<string> => {
  const plan = planView(run.config, ctx.storageRoot, run.workspaceHost);
  saveActiveViews(ctx.storageRoot, ctx.dataPath, plan ? [plan.options] : []);
  saveForwards(ctx.storageRoot, ctx.dataPath, run.config.sandbox.networking ? run.config.network.forwardPorts : []);
  saveAuditSettings(ctx.storageRoot, ctx.dataPath, { ...run.config.audit, projects: [run.workspaceHost] });
  saveMarkedProjects(ctx.storageRoot, ctx.dataPath, run.config.storage.markSandboxFiles ? [run.workspaceHost] : []);
  const size = readDataSize(ctx.storageRoot, ctx.dataPath);
  const limit = run.config.storage.warnDataGb;
  if (limit > 0 && size && size.bytes > limit * 1024 ** 3)
    console.warn(
      c.yellow(
        'The persisted data takes ' +
          humanBytes(size.bytes) +
          ' (more than storage.warnDataGb, ' +
          limit +
          ' GB). See what: sandbox data; free space: sandbox data clean <what>.',
      ),
    );
  if (!plan)
    return (
      viewSkipped(run.config, run.workspaceHost) ??
      'off (git-ignored files are visible in the sandbox; workspaceFilter.enabled keeps them out)'
    );
  const stats = await working('Preparing the workspace without its git-ignored files', () =>
    new WorkspaceView(plan.options).prepare(),
  );
  return (
    'on: git-ignored files stay on this PC' +
    (stats.toView || stats.toHost
      ? ' (' +
        stats.toView +
        ' copied in, ' +
        stats.toHost +
        ' out' +
        (stats.conflicts ? ', ' + stats.conflicts + ' conflicts kept next to the file' : '') +
        ')'
      : '') +
    '; ' +
    plan.options.view
  );
};

/** Everything a real launch does before the sandbox starts (skipped by `generate`, which only writes files). */
export const prepare = async (ctx: Context, run: ResolvedRun) => {
  const { options, dataPath, storageRoot } = ctx;
  const { config } = run;
  const accounts = new AccountStore(storageRoot);
  const account = options.account ?? accounts.defaultName();
  if (account && run.harnessName === 'claude' && account !== accounts.activeFor(dataPath))
    accounts.activate(dataPath, account);
  const terminal = config.provisioning.terminal.enabled
    ? await ensureTerminal(dataPath, config.provisioning.refresh, { pwsh: config.toolchains.pwsh.enabled !== false })
    : { exe: null, message: 'disabled' };
  const conpty = config.provisioning.conpty.enabled ? await ensureConpty(dataPath, config.provisioning.refresh) : 'off';
  const history = syncSummary(config, dataPath, run.workspaceHost);
  const guarded = checkRepo(dataPath);
  if (guarded.length)
    console.warn(
      c.yellow(
        'SECURITY: neutralised ' +
          guarded.length +
          ' change(s) the last sandbox made that could run code on this PC (see sandbox status).',
      ),
    );
  const stopped = new LifeRecord(storageRoot, dataPath).lastStopWarning(watcherRunning(dataPath));
  if (stopped) console.warn(c.yellow(stopped));
  if (updateRestartPending()) console.warn(c.yellow(UPDATE_RESTART_WARNING));
  new SandboxChannel(dataPath).reset();
  const filter = await prepareWorkspaceView(ctx, run);
  return {
    account,
    terminal: terminal.message + '; pseudo console: ' + conpty,
    history,
    pruned: describePrune(pruneStorage(storageRoot)),
    filter,
  };
};
