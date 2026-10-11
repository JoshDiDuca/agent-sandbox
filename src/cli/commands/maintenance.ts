// sync, logs, clean, config, doctor, host-claude and the internal sync watcher.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { DEFAULTS, userConfigPath, userDir } from '../../core/config.js';
import { fail, sleep, writeJson } from '../../core/util.js';
import { describePrune, pruneStorage } from '../../host/cleanup.js';
import { doctorRows, hostClaude, isSandboxRunning } from '../../host/platform.js';
import { readSandboxStatus } from '../../shared/rundir.js';
import { syncBack, watch } from '../../sync/watcher.js';
import { table, type Context } from './context.js';

export const sync = (ctx: Context): number => {
  const running = isSandboxRunning();
  const result = syncBack(ctx.loaded.config, ctx.dataPath, !running);
  console.log('History: ' + result.history + ' item(s) synced back. claude-mem: ' + result.claudeMem + (running ? ' (claude-mem syncs when the sandbox closes)' : ''));
  return 0;
};

const newestLog = (dir: string): string | null => {
  if (!fs.existsSync(dir)) return null;
  const newest = _.maxBy(fs.readdirSync(dir).filter((f) => /^(guest|daemon|bootstrap)-.*\.log$/.test(f)), (f) => fs.statSync(path.join(dir, f)).mtimeMs);
  return newest ? path.join(dir, newest) : null;
};

export const logs = async (ctx: Context): Promise<number> => {
  const dir = path.join(ctx.dataPath, 'logs');
  const file = newestLog(dir) ?? fail('No logs yet in ' + dir);
  console.log('== ' + file + ' ==');
  let printed = 0;
  const print = (): void => {
    const text = fs.readFileSync(file, 'utf8');
    process.stdout.write(printed === 0 ? text.split('\n').slice(-120).join('\n') : text.slice(printed));
    printed = text.length;
  };
  print();
  while (ctx.options.follow) { await sleep(1000); print(); }
  return 0;
};

export const clean = (ctx: Context): number => {
  const running = isSandboxRunning() ? readSandboxStatus(ctx.dataPath)?.launchId : undefined;
  console.log('Cleanup: ' + describePrune(pruneStorage(ctx.storageRoot, { launchDays: ctx.options.days, keep: _.compact([running]) })));
  return 0;
};

const initConfig = (ctx: Context): number => {
  const file = userConfigPath();
  if (fs.existsSync(file)) fail(file + ' already exists.');
  const example = path.join(ctx.packageRoot, 'config.example.json');
  fs.mkdirSync(path.join(userDir(), 'hooks', 'pre-agent'), { recursive: true });
  if (fs.existsSync(example)) fs.copyFileSync(example, file); else writeJson(file, DEFAULTS);
  console.log('Created ' + file + ' (only keep the keys you change). Your own hooks go in ' + path.join(userDir(), 'hooks'));
  return 0;
};

export const config = (ctx: Context): number => {
  const [action = 'show'] = ctx.options.positionals;
  switch (action) {
    case 'path': console.log(ctx.loaded.configPath ?? userConfigPath() + '  (does not exist yet)'); return 0;
    case 'init': return initConfig(ctx);
    case 'show': console.log(JSON.stringify(ctx.loaded.config, null, 2)); return 0;
    default: fail('Unknown config action "' + action + '" (show | path | init)');
  }
};

export const doctor = (ctx: Context): number => {
  table(doctorRows(ctx.loaded.config, ctx.options.harness ?? ctx.loaded.config.defaultHarness, ctx.storageRoot, ctx.loaded.configPath));
  return 0;
};

export const claudeHost = (ctx: Context): number => hostClaude(ctx.storageRoot, ctx.options.personal, ctx.options.passthrough);

export const watcher = (ctx: Context): Promise<void> => watch(ctx.loaded.config, ctx.dataPath);
