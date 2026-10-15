// `sandbox engine`: the engine in use and, for each engine, what it can do and whether this PC can run it.
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

export async function engine(ctx: Context): Promise<number> {
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
