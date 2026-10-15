// `sandbox doctor` and `sandbox repair`: both run the same checks through the same engine, a line each as it ends.
// doctor only looks (and offers to fix, or fixes with --fix); repair looks, lists what it would change, asks once, then
// fixes and writes a log. --json prints the results instead and never asks.
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import { DEFAULTS, userDir } from '../../../core/config/index.js';
import { packageVersion } from '../../../core/package-info.js';
import { expandPath, UserError } from '../../../core/util/index.js';
import { insideSandbox } from '../../../host/sandbox/index.js';
import type { CliOptions } from '../../args.js';
import { printJson, table } from '../../output/index.js';
import { HealthService } from '../../services/index.js';
import { createContext, requireOnPc, type Context } from '../context.js';
import { ALL_CHECKS } from './checks/index.js';
import { buildEnv } from './env.js';
import { HealthRun, summarize } from './engine.js';
import { logText, writeRepairLog } from './log.js';
import { HealthPrinter } from './printer.js';
import type { Check, CheckResult, RepairEnv, Summary } from './types.js';

const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const stdout = { write: (text: string): void => void process.stdout.write(text) };

/** What both commands find, and what they do about it. */
export interface HealthReport {
  readonly found: CheckResult[];
  readonly final: CheckResult[];
  readonly summary: Summary;
  /** Fixes were applied. */
  readonly changed: boolean;
}

interface Plan {
  /** Fix without asking. */
  readonly yes: boolean;
  /** May ask (a terminal, and not --json). */
  readonly ask: boolean;
  /** The question asked after the list of what will change. */
  readonly question: (n: number) => string;
}

/** Runs the checks, then (when allowed) the fixes. `printer` is null for --json. */
export async function runHealth(
  env: RepairEnv,
  printer: HealthPrinter | null,
  plan: Plan,
  checks: readonly Check[] = ALL_CHECKS,
  confirmFix: (question: string) => Promise<boolean> = (q) => confirm({ message: q, default: true }),
): Promise<HealthReport> {
  const run = new HealthRun(checks, env, printer?.hooks());
  const found = await run.look();
  const fixable = found.filter((r) => r.fixable);
  let final = found;
  let changed = false;
  if (fixable.length) {
    let go = plan.yes;
    if (!go && plan.ask) {
      printer?.plan(fixable);
      go = await confirmFix(plan.question(fixable.length));
    }
    if (go) {
      if (plan.yes) printer?.plan(fixable);
      final = await run.fix(found);
      changed = true;
    } else printer?.line('\nNothing was changed.');
  }
  return { found, final, summary: summarize(final), changed };
}

function quote(n: number, what: string): string {
  return n + ' ' + what + (n === 1 ? '' : 's');
}

/** `sandbox doctor` */
export async function runDoctor(ctx: Context): Promise<number> {
  const health = new HealthService(ctx);
  if (insideSandbox()) {
    table(health.doctor());
    return 0;
  }
  const json = ctx.options.json;
  const printer = json ? null : new HealthPrinter(stdout);
  printer?.title('Checking this PC, the install, your settings and the sandbox...');
  const env = buildEnv(ctx);
  const report = await runHealth(env, printer, {
    yes: ctx.options.fix,
    ask: !json && interactive(),
    question: (n) => quote(n, 'problem') + ' can be fixed. Fix ' + (n === 1 ? 'it' : 'them') + ' now?',
  });
  const details = health.doctor();
  if (printJson(ctx, { checks: report.final, summary: report.summary, details })) return 0;
  printer?.summary(report.final, report.summary);
  const left = report.final.filter((r) => r.fixable).length;
  if (left && !report.changed)
    printer?.line('\n' + quote(left, 'problem') + ' can be fixed: run sandbox repair (or sandbox doctor --fix).');
  printer?.line('\n' + 'Details');
  table(details);
  return 0;
}

/** `sandbox repair` for a loaded context. */
export async function runRepair(ctx: Context, configError: UserError | null = null): Promise<number> {
  requireOnPc('repair');
  const json = ctx.options.json;
  const printer = json ? null : new HealthPrinter(stdout);
  printer?.title('Checking this PC, the install, your settings and the sandbox...');
  const env = buildEnv(ctx, configError);
  const yes = ctx.options.yes;
  const ask = !json && interactive();
  const report = await runHealth(env, printer, {
    yes,
    ask,
    question: (n) => 'Fix ' + (n === 1 ? 'this problem' : 'these ' + n + ' problems') + '?',
  });
  const when = new Date();
  const log = writeRepairLog(
    ctx.storageRoot,
    logText({
      when,
      version: packageVersion(),
      command: 'sandbox repair' + (yes ? ' --yes' : ''),
      found: report.found,
      final: report.final,
      summary: report.summary,
    }),
    when,
  );
  const stillFixable = report.final.filter((r) => r.fixable).length;
  if (printJson(ctx, { checks: report.final, summary: report.summary, changed: report.changed, log })) {
    return report.summary.needsYou ? 1 : 0;
  }
  printer?.summary(report.final, report.summary);
  if (stillFixable && !ask && !yes)
    printer?.line('\n' + quote(stillFixable, 'problem') + ' can be fixed: run sandbox repair --yes.');
  printer?.line(
    log
      ? '\nLog of what was found and changed: ' + log
      : '\nNo log was written (the storage folder does not exist yet).',
  );
  return report.summary.needsYou ? 1 : 0;
}

/**
 * Entry point that works even when the config file is broken (createContext would throw): falls back to the built-in
 * defaults so the other checks still run, and reports the settings problem as a check of its own.
 */
export function repairCommand(packageRoot: string, entry: string, options: CliOptions): Promise<number> {
  let ctx: Context;
  try {
    ctx = createContext(packageRoot, entry, options);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    const loaded = { config: structuredClone(DEFAULTS), configPath: null, base: userDir() };
    const storageRoot = expandPath(loaded.config.storage.root, loaded.base);
    return runRepair(
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
  return runRepair(ctx);
}
