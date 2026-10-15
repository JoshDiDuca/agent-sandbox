// `sandbox engine`: the engine in use and, for each engine, what it can do and whether this PC can run it.
import { fail } from '../../core/util/index.js';
import { engineReports, type EngineCapabilities } from '../../host/engines/index.js';
import { c, printJson, table } from '../output/index.js';
import type { Context } from './context.js';

const CAPABILITY_NAMES: Readonly<Record<keyof EngineCapabilities, string>> = {
  desktop: 'desktop window',
  gpu: 'GPU',
  clipboard: 'clipboard',
  audio: 'audio',
  video: 'camera',
  printers: 'printers',
  liveFolderAdd: 'add folders while running',
  attachedDisks: 'attached disks',
  multipleInstances: 'several at once',
  hvsocket: 'Hyper-V sockets',
};

/** sandbox engine check <engine>: the reasons and the exact commands, in plain words. Nothing is run or changed. */
async function checkEngine(ctx: Context, name: string): Promise<number> {
  const report = (await engineReports(ctx.loaded.config)).find((r) => r.id === name);
  if (!report) return fail('Unknown engine: ' + name, 'Use windows-sandbox or hcs.');
  if (printJson(ctx, report)) return report.check.available ? 0 : 1;
  if (report.check.available) {
    console.log(c.green(name + ' can be used on this PC.'));
    if (name === 'hcs') console.log('HCS is in alpha: starting it is not enabled yet (docs/design/engines.md).');
    return 0;
  }
  console.log(c.yellow(name + ' cannot be used on this PC yet:'));
  report.check.reasons.forEach((reason, i) => {
    console.log('\n  ' + (i + 1) + '. ' + reason);
    console.log('     To fix: ' + (report.check.fixes[i] ?? 'see docs/design/engines.md'));
  });
  console.log('\nNothing was changed. These commands change Windows, so they are yours to run (or not).');
  return 1;
}

export async function engine(ctx: Context): Promise<number> {
  const [action = 'show', name = 'hcs'] = ctx.options.positionals;
  if (action === 'check') return checkEngine(ctx, name);
  const reports = await engineReports(ctx.loaded.config);
  const using = reports.find((r) => r.inUse);
  if (printJson(ctx, { engine: using?.id, engines: reports })) return 0;
  console.log('Engine in use: ' + (using?.id ?? ctx.loaded.config.sandbox.engine) + '  (setting: sandbox.engine)');
  for (const report of reports) {
    console.log('\n' + report.id + (report.inUse ? '  (in use)' : ''));
    console.log('  ' + (report.check.available ? c.green('can be used on this PC') : c.yellow('cannot be used yet')));
    for (const reason of report.check.reasons) console.log('  ' + reason);
    for (const fix of report.check.fixes) console.log('  Fix: ' + fix);
    table(
      Object.entries(CAPABILITY_NAMES).map(([key, name]) => [
        '  ' + name,
        report.capabilities[key as keyof EngineCapabilities] ? 'yes' : 'no',
      ]),
    );
  }
  return 0;
}
