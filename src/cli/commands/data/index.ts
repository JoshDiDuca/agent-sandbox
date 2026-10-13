// `sandbox data`: what persists between sandboxes (toolchains, databases, agent state, logs, host storage) and
// removing chosen parts of it. Everything under the data folder is sandbox-writable: sizes and deletes never follow
// links, and targets resolve strictly inside the data folder.
import _ from 'lodash';
import { humanBytes } from '../../../core/disk.js';
import { fail } from '../../../core/util/index.js';
import { printJson, table, working } from '../../output/index.js';
import { DataService } from '../../services/index.js';
import { type Context } from '../context.js';
import { dataClean } from './clean.js';
import { type DataArea } from './collect.js';

const AREA_LABEL: Record<DataArea, string> = {
  tools: 'Toolchains',
  databases: 'Databases',
  state: 'Agent state',
  logs: 'Logs',
  data: 'Other',
  host: 'On this PC',
};

export async function dataInfo(ctx: Context): Promise<number> {
  const report = await working(
    'Measuring the saved data (big folders take a moment)',
    () => new DataService(ctx).report(),
    !ctx.options.json,
  );
  const { entries, disks, totalBytes: total } = report;
  if (printJson(ctx, { dataPath: ctx.dataPath, storageRoot: ctx.storageRoot, totalBytes: total, entries, disks }))
    return 0;
  console.log('Disks\n');
  table([
    ['DRIVE', 'USED', 'FREE', 'SIZE', ''],
    ...disks.map((d) => [
      d.drive,
      humanBytes(d.usedBytes) + ' (' + Math.round((d.usedBytes / d.totalBytes) * 100) + '%)',
      humanBytes(d.freeBytes),
      humanBytes(d.totalBytes),
      d.holdsStorage ? '<- sandbox storage (' + humanBytes(total) + ' of it)' : '',
    ]),
  ]);
  console.log('');
  console.log('Persistent data for the sandbox: ' + ctx.dataPath + ' (C:\\AgentData inside)\n');
  if (!entries.length) {
    console.log('Nothing stored yet. Toolchains, databases and agent logins appear here after the first start.');
    return 0;
  }
  const rows = _.flatMap(_.groupBy(entries, 'area'), (group, area) => [
    [AREA_LABEL[area as DataArea], humanBytes(_.sumBy(group, 'bytes')), ''],
    ...group.map((e) => ['  ' + e.name, humanBytes(e.bytes), e.path]),
  ]);
  table([...rows, ['', '', ''], ['Total', humanBytes(total), '']]);
  console.log(
    '\nFree space with: sandbox data clean <target...>  (e.g. tools/go, databases/postgres-18, logs, launches)',
  );
  return 0;
}

/** `sandbox data [info|clean] [targets...]`. */
export function data(ctx: Context): number | Promise<number> {
  const [action = 'info'] = ctx.options.positionals;
  switch (action) {
    case 'info':
    case 'show':
    case 'list':
      return dataInfo(ctx);
    case 'clean':
    case 'remove':
      return dataClean(ctx);
    default:
      return fail(
        'Unknown data action "' + action + '".',
        'Use: sandbox data  (what is stored)  or  sandbox data clean <target...>',
      );
  }
}
