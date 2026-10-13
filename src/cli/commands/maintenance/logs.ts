import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { assertNoLinks, fail, safeText, sleep } from '../../../core/util/index.js';
import { type Context } from '../context.js';

const newestLog = (dir: string): string | null => {
  if (!fs.existsSync(dir)) return null;
  const logs = fs
    .readdirSync(dir)
    .filter((f) => /^(guest|daemon|bootstrap)-.*\.log$/.test(f) && fs.lstatSync(path.join(dir, f)).isFile());
  const newest = _.maxBy(logs, (f) => fs.statSync(path.join(dir, f)).mtimeMs);
  return newest ? path.join(dir, newest) : null;
};

export const logs = async (ctx: Context): Promise<number> => {
  const dir = path.join(ctx.dataPath, 'logs');
  // The sandbox writes this folder: never read through a link it planted there.
  assertNoLinks(ctx.dataPath, dir);
  const file =
    newestLog(dir) ??
    fail('No sandbox logs yet in ' + dir + '.', 'Logs appear after the first start (sandbox claude).');
  console.log('== ' + file + ' ==');
  let printed = 0;
  // The log is written inside the sandbox: read only its tail, and make it safe for your terminal.
  const print = (): void => {
    const size = fs.statSync(file).size;
    const from = printed === 0 ? Math.max(0, size - 64 * 1024) : printed;
    if (size <= from) return;
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(size - from, 4 * 1024 * 1024));
    fs.readSync(fd, buffer, 0, buffer.length, from);
    fs.closeSync(fd);
    const text = safeText(buffer.toString('utf8'));
    process.stdout.write(printed === 0 ? text.split('\n').slice(-120).join('\n') : text);
    printed = from + buffer.length;
  };
  print();
  if (ctx.options.follow) console.error('(following; Ctrl+C to stop)');
  while (ctx.options.follow) {
    await sleep(1000);
    print();
  }
  return 0;
};
