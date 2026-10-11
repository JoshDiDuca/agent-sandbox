// `sandbox repair`: finds and fixes common problems. Each check (checks.ts) either confirms all is well (OK), fixes the
// problem itself (FIXED), or says what you need to do (NEEDS YOU). Toolchain and run-state fixes wait until no
// sandbox is running.
import path from 'node:path';
import _ from 'lodash';
import { DEFAULTS, loadConfig, userDir } from '../../../core/config.js';
import { errMsg, expandPath, UserError } from '../../../core/util.js';
import { isSandboxRunning } from '../../../host/platform.js';
import type { CliOptions } from '../../args.js';
import { createContext, printJson, table, type Context } from '../context.js';
import { CHECKS } from './checks.js';
import type { RepairCheck, RepairEnv, RepairResult, RepairStatus } from './types.js';

const LABEL: Record<RepairStatus, string> = { ok: 'OK', fixed: 'FIXED', 'needs-you': 'NEEDS YOU', warn: 'WARNING', skipped: 'SKIPPED' };

/** Runs every check in order; a check that throws is reported, never stops the rest. */
export const runChecks = (env: RepairEnv, checks: RepairCheck[] = CHECKS): RepairResult[] => checks.map((check) => {
  try {
    return { name: check.name, ...check.run(env) };
  } catch (e) {
    const fix = e instanceof UserError && e.fix ? ' ' + e.fix : '';
    return { name: check.name, status: 'needs-you', detail: 'check failed: ' + errMsg(e) + fix };
  }
});

export const repair = (ctx: Context, configError: UserError | null = null): number => {
  const env: RepairEnv = { ctx, running: isSandboxRunning(), dataPath: ctx.dataPath, storageRoot: ctx.storageRoot, toolsDir: path.join(ctx.dataPath, 'tools'), configError };
  // Re-check the config file even when the context loaded (it may have been edited since, or come from --config).
  if (!env.configError) { try { loadConfig(ctx.options.config); } catch (e) { if (e instanceof UserError) env.configError = e; else throw e; } }
  const results = runChecks(env);
  if (printJson(ctx, results)) return results.some((r) => r.status === 'needs-you') ? 1 : 0;
  table(results.map((r) => [LABEL[r.status], r.name, r.detail]));
  const counts = _.countBy(results, 'status');
  console.log('\n' + (counts['needs-you'] ? counts['needs-you'] + ' thing(s) need you (see NEEDS YOU above).' : 'All good' + (counts.fixed ? ': fixed ' + counts.fixed + ' problem(s).' : '.')));
  return counts['needs-you'] ? 1 : 0;
};

/**
 * Entry point that works even when the config file is broken (createContext would throw): falls back to the built-in
 * defaults so the other checks still run, and reports the config problem as the first check.
 */
export const repairCommand = (packageRoot: string, entry: string, options: CliOptions): number => {
  let ctx: Context;
  try { ctx = createContext(packageRoot, entry, options); } catch (e) {
    if (!(e instanceof UserError)) throw e;
    const loaded = { config: structuredClone(DEFAULTS), configPath: null, base: userDir() };
    const storageRoot = expandPath(loaded.config.storage.root, loaded.base);
    return repair({ packageRoot, entry, options, loaded, storageRoot, dataPath: path.join(storageRoot, 'data', loaded.config.storage.dataName) }, e);
  }
  return repair(ctx);
};
