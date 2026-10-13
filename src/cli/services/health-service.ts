// Is this PC (and the sandbox) in good shape: doctor rows, repair checks, the setup checklist. Never prints.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../core/config/index.js';
import { errMsg, expandPath, fail, isWin, UserError } from '../../core/util/index.js';
import { detectWsb, doctorRows, insideSandbox, isSandboxRunning } from '../../host/sandbox/index.js';
import { KnownProjects, ProjectRegistry } from '../../host/projects/index.js';
import { refuseInSelfTest } from '../../host/test-guard.js';
import { SYSTEM } from '../../shared/system.js';
import type { Context } from '../commands/context.js';
import { CHECKS } from '../commands/repair/checks.js';
import type { RepairCheck, RepairEnv, RepairResult } from '../commands/repair/types.js';
import { buildChecks, canEnableFeature, type Check } from '../commands/setup/checks.js';
import { ENABLE_COMMAND, gatherFacts, type MachineFacts } from '../commands/setup/facts.js';

/** Runs every check in order; a check that throws is reported, never stops the rest. */
export function runChecks(env: RepairEnv, checks: RepairCheck[] = CHECKS): RepairResult[] {
  return checks.map((check) => {
    try {
      return { name: check.name, ...check.run(env) };
    } catch (e) {
      const fix = e instanceof UserError && e.fix ? ' ' + e.fix : '';
      return { name: check.name, status: 'needs-you', detail: 'check failed: ' + errMsg(e) + fix };
    }
  });
}

/** What `sandbox setup` found out about this PC. */
export interface SetupReport {
  readonly facts: MachineFacts;
  readonly checks: Check[];
  /** The Windows Sandbox feature is off and this edition can have it. */
  readonly canEnable: boolean;
}

export class HealthService {
  constructor(private readonly ctx: Context) {}

  /** The table `doctor` shows: [name, detail] rows. */
  doctor(): string[][] {
    const { ctx } = this;
    const rows = doctorRows(
      ctx.loaded.config,
      ctx.options.harness ?? ctx.loaded.config.defaultHarness,
      ctx.storageRoot,
      ctx.loaded.configPath,
    );
    // Inside a sandbox the feature and "running" rows describe the sandbox itself, and the host rows describe nothing
    // useful.
    if (insideSandbox())
      return [
        ['Where', 'inside a Windows Sandbox started by this tool (run doctor on your PC to check the PC)'],
        ...rows.filter(([name]) => name === 'Config file'),
      ];
    // Several projects: the roots mapped at every start, what the running sandbox has, and whether wsb share is there.
    const p = ctx.loaded.config.projects;
    const registry = isSandboxRunning() ? new ProjectRegistry(ctx.storageRoot).read() : null;
    const wsb = p.wsbShare ? detectWsb() : null;
    return [
      ...rows,
      [
        'Project roots',
        p.roots.length
          ? p.roots.map((r) => expandPath(r, ctx.loaded.base)).join(', ')
          : 'none (sandbox projects roots add <folder>)',
      ],
      [
        'All projects',
        p.all
          ? 'on: ' +
            new KnownProjects(ctx.storageRoot).list().length +
            ' known project(s) mapped at every start (' +
            p.exclude.length +
            ' excluded)'
          : 'off',
      ],
      ['Projects running', registry ? registry.projects.map((x) => x.name + ' (' + x.mechanism + ')').join(', ') : '-'],
      [
        'wsb share',
        !p.wsbShare
          ? 'off (projects.wsbShare)'
          : wsb
            ? 'available: ' +
              wsb.exe +
              (wsb.version ? ' ' + wsb.version : '') +
              ' (untested; a failure offers a restart instead)'
            : 'not on this Windows (needs Windows 11 24H2+ with the updated Windows Sandbox): folders outside your roots need a restart',
      ],
    ];
  }

  /** Runs the repair checks (and the fixes they make). A config file that does not load is the first problem. */
  repair(configError: UserError | null = null): RepairResult[] {
    const { ctx } = this;
    const env: RepairEnv = {
      ctx,
      running: isSandboxRunning(),
      dataPath: ctx.dataPath,
      storageRoot: ctx.storageRoot,
      toolsDir: path.join(ctx.dataPath, 'tools'),
      configError,
    };
    // Re-check the config file even when the context loaded (it may have been edited since, or come from --config).
    if (!env.configError) {
      try {
        loadConfig(ctx.options.config);
      } catch (e) {
        if (e instanceof UserError) env.configError = e;
        else throw e;
      }
    }
    return runChecks(env);
  }

  /** Fails unless this is Windows: Windows Sandbox runs nowhere else. */
  assertWindows(): void {
    if (!isWin)
      fail(
        'Windows Sandbox only runs on Windows.',
        'Run sandbox setup on a Windows 10/11 Pro, Enterprise or Education PC.',
      );
  }

  /** The setup checklist for this PC. */
  setupReport(): SetupReport {
    const facts = gatherFacts(this.ctx.storageRoot);
    return { facts, checks: buildChecks(facts), canEnable: canEnableFeature(facts) };
  }

  /** Runs the enable command in an elevated PowerShell (Windows asks for permission); true if it worked. */
  enableFeature(): boolean {
    refuseInSelfTest('turn on Windows features');
    const inner = "'-NoProfile','-Command','" + ENABLE_COMMAND + " | Out-Null'";
    const outer =
      "try { $p = Start-Process -FilePath '" +
      SYSTEM.powershell() +
      "' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList " +
      inner +
      '; exit $p.ExitCode } catch { exit 1 }';
    return (
      spawnSync(SYSTEM.powershell(), ['-NoProfile', '-NonInteractive', '-Command', outer], { stdio: 'inherit' })
        .status === 0
    );
  }
}
