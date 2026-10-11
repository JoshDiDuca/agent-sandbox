// sync, logs, clean, config, doctor, host-claude and the internal sync watcher.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import _ from 'lodash';
import { DEFAULTS, userConfigPath, userDir } from '../../core/config.js';
import { fail, safeText, sleep, writeJson } from '../../core/util.js';
import { describePrune, pruneStorage } from '../../host/cleanup.js';
import { doctorRows, hostClaude, isSandboxRunning } from '../../host/platform.js';
import { readSandboxStatus } from '../../shared/rundir.js';
import { syncBack, watch } from '../../sync/watcher.js';
import { table, type Context } from './context.js';

export const sync = (ctx: Context): number => {
  const running = isSandboxRunning();
  const result = syncBack(ctx.dataPath, !running);
  console.log('History: ' + result.history + ' item(s) synced back. claude-mem: ' + result.claudeMem + (running ? ' (claude-mem syncs when the sandbox closes)' : ''));
  return 0;
};

const newestLog = (dir: string): string | null => {
  if (!fs.existsSync(dir)) return null;
  const logs = fs.readdirSync(dir).filter((f) => /^(guest|daemon|bootstrap)-.*\.log$/.test(f) && fs.lstatSync(path.join(dir, f)).isFile());
  const newest = _.maxBy(logs, (f) => fs.statSync(path.join(dir, f)).mtimeMs);
  return newest ? path.join(dir, newest) : null;
};

export const logs = async (ctx: Context): Promise<number> => {
  const dir = path.join(ctx.dataPath, 'logs');
  const file = newestLog(dir) ?? fail('No sandbox logs yet in ' + dir + '.', 'Logs appear after the first start (claude-sbx).');
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
  while (ctx.options.follow) { await sleep(1000); print(); }
  return 0;
};

export const clean = (ctx: Context): number => {
  const running = isSandboxRunning() ? readSandboxStatus(ctx.dataPath)?.launchId : undefined;
  console.log('Cleanup: ' + describePrune(pruneStorage(ctx.storageRoot, { launchDays: ctx.options.days, keep: _.compact([running]) })));
  return 0;
};

const initConfig = (): number => {
  const file = userConfigPath();
  if (fs.existsSync(file)) fail(file + ' already exists.');
  fs.mkdirSync(path.join(userDir(), 'hooks', 'pre-agent'), { recursive: true });
  // The schema sits next to the file (a local path), so editors trust it and show docs and autocomplete.
  writeJson(file, { $schema: './config.schema.json', ...DEFAULTS });
  console.log('Created ' + file + '. It lists every setting with its default; delete the ones you do not change.');
  console.log('Your own hook scripts go in ' + path.join(userDir(), 'hooks') + '\\{pre-provision,pre-agent,post-agent}.');
  console.log('For editor help in every project\'s .sandbox-config.json, run: agent-sandbox config schema');
  return 0;
};

/**
 * VS Code setting that maps every .sandbox-config.json (and the user config) to the local schema files, so project
 * files need no "$schema" line and nothing is fetched from the internet (remote schemas need trusting).
 */
const printSchemaSettings = (): number => {
  const url = (name: string): string => pathToFileURL(path.join(userDir(), name)).href;
  const setting = {
    'json.schemas': [
      { fileMatch: ['**/.sandbox-config.json'], url: url('sandbox-config.schema.json') },
      { fileMatch: ['**/.agent-sandbox/config.json'], url: url('config.schema.json') },
    ],
  };
  console.log('Add this to your VS Code settings.json (Ctrl+Shift+P > "Preferences: Open User Settings (JSON)"):\n');
  console.log(JSON.stringify(setting, null, 2).slice(2, -2));
  console.log('\nThe schema files live in ' + userDir() + ' and are refreshed whenever agent-sandbox runs.');
  return 0;
};

export const config = (ctx: Context): number => {
  const [action = 'show'] = ctx.options.positionals;
  switch (action) {
    case 'path': console.log(ctx.loaded.configPath ?? userConfigPath() + '  (does not exist yet)'); return 0;
    case 'init': return initConfig();
    case 'show': console.log(JSON.stringify(ctx.loaded.config, null, 2)); return 0;
    case 'schema': return printSchemaSettings();
    default: fail('Unknown config action "' + action + '".', 'Use one of: agent-sandbox config show | path | init | schema');
  }
};

export const doctor = (ctx: Context): number => {
  table(doctorRows(ctx.loaded.config, ctx.options.harness ?? ctx.loaded.config.defaultHarness, ctx.storageRoot, ctx.loaded.configPath));
  return 0;
};

export const claudeHost = (ctx: Context): number => hostClaude(ctx.storageRoot, ctx.options.personal, ctx.options.passthrough);

export const watcher = (ctx: Context): Promise<void> => watch(ctx.dataPath);
