// Builds what the checks read (RepairEnv) for the real PC from the command's context. Tests build their own.
import path from 'node:path';
import { loadConfig, machineRoot, userConfigPath, userDir } from '../../../core/config/index.js';
import { UserError } from '../../../core/util/index.js';
import { WindowsProbe, type SystemProbe } from '../../../host/health/index.js';
import { InstallLayout, InstallRecordFile } from '../../../host/install/index.js';
import { MIGRATIONS } from '../../../host/migrate/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { hostDataFolder } from '../../../host/storage/index.js';
import type { Context } from '../context.js';
import { gatherFacts, type MachineFacts } from '../setup/facts.js';
import type { RepairEnv } from './types.js';

/** The settings file in use: --config, AGENT_SANDBOX_CONFIG, else the user's config.json. */
export function configFileOf(ctx: Context): string {
  return path.resolve(ctx.options.config ?? process.env.AGENT_SANDBOX_CONFIG ?? userConfigPath());
}

/** The settings problem to report: the one the context was made without, or a fresh one (the file may have changed). */
function configProblem(ctx: Context, known: UserError | null): UserError | null {
  if (known) return known;
  try {
    loadConfig(ctx.options.config);
    return null;
  } catch (e) {
    if (e instanceof UserError) return e;
    throw e;
  }
}

export function buildEnv(
  ctx: Context,
  configError: UserError | null = null,
  system: SystemProbe = new WindowsProbe(),
): RepairEnv {
  const layout = InstallLayout.detect(ctx.packageRoot);
  let facts: MachineFacts | null = null;
  return {
    ctx,
    running: isSandboxRunning(),
    dataPath: ctx.dataPath,
    storageRoot: ctx.storageRoot,
    toolsDir: hostDataFolder(ctx.dataPath, 'tools'),
    configError: configProblem(ctx, configError),
    layout,
    record: layout ? new InstallRecordFile(layout.root).read() : null,
    machineHome: machineRoot(),
    userDir: userDir(),
    configFile: configFileOf(ctx),
    migrations: MIGRATIONS,
    userInstallRoot: process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'WindowsDevelopmentSandbox') : null,
    system,
    now: Date.now,
    facts: (): MachineFacts => (facts ??= gatherFacts(ctx.storageRoot)),
  };
}
