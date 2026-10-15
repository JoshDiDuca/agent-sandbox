import { sleep } from '../../../core/util/index.js';
import { newestCrashReport } from '../../../host/life/index.js';
import { LogsService } from '../../services/index.js';
import { type Context } from '../context.js';

/** The newest crash report (written by the background sync when the sandbox or this PC went down). */
function printCrashReport(ctx: Context): number {
  const report = newestCrashReport(ctx.storageRoot);
  if (!report) {
    console.log('No crash report yet: no sandbox has ended in a crash since this was installed.');
    return 0;
  }
  console.log('== ' + report.file + ' ==');
  console.log(report.text);
  return 0;
}

export async function logs(ctx: Context): Promise<number> {
  if (ctx.options.crash) return printCrashReport(ctx);
  const service = new LogsService(ctx);
  const file = service.newest();
  console.log('== ' + file + ' ==');
  let printed = 0;
  // The log is written inside the sandbox: read only its tail, and make it safe for your terminal.
  const print = (): void => {
    const chunk = service.read(file, printed);
    if (!chunk) return;
    process.stdout.write(printed === 0 ? chunk.text.split('\n').slice(-120).join('\n') : chunk.text);
    printed = chunk.next;
  };
  print();
  if (ctx.options.follow) console.error('(following; Ctrl+C to stop)');
  while (ctx.options.follow) {
    await sleep(1000);
    print();
  }
  return 0;
}
