import { expandPath } from '../../../core/util/index.js';
import { KnownProjects, ProjectRegistry } from '../../../host/projects/index.js';
import { detectWsb, doctorRows, insideSandbox, isSandboxRunning } from '../../../host/sandbox/index.js';
import { table } from '../../output/index.js';
import { type Context } from '../context.js';

export function doctor(ctx: Context): number {
  const rows = doctorRows(
    ctx.loaded.config,
    ctx.options.harness ?? ctx.loaded.config.defaultHarness,
    ctx.storageRoot,
    ctx.loaded.configPath,
  );
  // Inside a sandbox the feature and "running" rows describe the sandbox itself, and the host rows describe nothing
  // useful.
  if (insideSandbox()) {
    table([
      ['Where', 'inside a Windows Sandbox started by this tool (run doctor on your PC to check the PC)'],
      ...rows.filter(([name]) => name === 'Config file'),
    ]);
    return 0;
  }
  // Several projects: the roots mapped at every start, what the running sandbox has, and whether wsb share is there.
  const p = ctx.loaded.config.projects;
  const registry = isSandboxRunning() ? new ProjectRegistry(ctx.storageRoot).read() : null;
  const wsb = p.wsbShare ? detectWsb() : null;
  table([
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
  ]);
  return 0;
}
