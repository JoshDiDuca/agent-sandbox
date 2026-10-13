// `sandbox repair`: finds and fixes common problems. Each check (checks.ts) either confirms all is well (OK), fixes the
// problem itself (FIXED), or says what you need to do (NEEDS YOU). Toolchain and run-state fixes wait until no
// sandbox is running.
import path from 'node:path';
import _ from 'lodash';
import { DEFAULTS, userDir } from '../../../core/config/index.js';
import { expandPath, UserError } from '../../../core/util/index.js';
import type { CliOptions } from '../../args.js';
import { createContext, type Context } from '../context.js';
import { printJson, table } from '../../output/index.js';
import { HealthService } from '../../services/index.js';
import type { RepairStatus } from './types.js';

const LABEL: Record<RepairStatus, string> = {
  ok: 'OK',
  fixed: 'FIXED',
  'needs-you': 'NEEDS YOU',
  warn: 'WARNING',
  skipped: 'SKIPPED',
};

export function repair(ctx: Context, configError: UserError | null = null): number {
  const results = new HealthService(ctx).repair(configError);
  if (printJson(ctx, results)) return results.some((r) => r.status === 'needs-you') ? 1 : 0;
  table(results.map((r) => [LABEL[r.status], r.name, r.detail]));
  const counts = _.countBy(results, 'status');
  console.log(
    '\n' +
      (counts['needs-you']
        ? counts['needs-you'] + ' thing(s) need you (see NEEDS YOU above).'
        : 'All good' + (counts.fixed ? ': fixed ' + counts.fixed + ' problem(s).' : '.')),
  );
  return counts['needs-you'] ? 1 : 0;
}

/**
 * Entry point that works even when the config file is broken (createContext would throw): falls back to the built-in
 * defaults so the other checks still run, and reports the config problem as the first check.
 */
export function repairCommand(packageRoot: string, entry: string, options: CliOptions): number {
  let ctx: Context;
  try {
    ctx = createContext(packageRoot, entry, options);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    const loaded = { config: structuredClone(DEFAULTS), configPath: null, base: userDir() };
    const storageRoot = expandPath(loaded.config.storage.root, loaded.base);
    return repair(
      {
        packageRoot,
        entry,
        options,
        loaded,
        storageRoot,
        dataPath: path.join(storageRoot, 'data', loaded.config.storage.dataName),
      },
      e,
    );
  }
  return repair(ctx);
}
