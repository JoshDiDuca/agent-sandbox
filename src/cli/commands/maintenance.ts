// sync, logs, clean, config, doctor, host-claude and the internal sync watcher.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import _ from 'lodash';
import { DEFAULTS, userConfigPath, userDir } from '../../core/config/index.js';
import {
  describeOverrides,
  isTrusted,
  LOCAL_CONFIG_NAME,
  normalizeOverrides,
  readLocalConfig,
  trustStorePath,
} from '../../core/local-config/index.js';
import { assertNoLinks, expandPath, fail, plainText, safeText, sleep, writeJson } from '../../core/util/index.js';
import { humanBytes } from '../../core/disk.js';
import { AuditLog } from '../../host/audit/log.js';
import { readKnown } from '../../host/projects/index.js';
import { readRegistry } from '../../host/projects/index.js';
import { detectWsb } from '../../host/sandbox/index.js';
import { describePrune, pruneStorage } from '../../host/storage/index.js';
import { doctorRows } from '../../host/sandbox/index.js';
import { hostClaude } from '../../host/sandbox/index.js';
import { insideSandbox, isSandboxRunning } from '../../host/sandbox/index.js';
import { readSandboxStatus } from '../../shared/channel/index.js';
import { syncBack } from '../../sync/index.js';
import { watch } from '../../sync/index.js';
import { printJson, table, type Context } from './context.js';
import { c } from '../colors.js';

export const sync = (ctx: Context): number => {
  const running = isSandboxRunning();
  const result = syncBack(ctx.dataPath, !running);
  console.log(
    'History: ' +
      result.history +
      ' item(s) synced back. claude-mem: ' +
      result.claudeMem +
      (running ? ' (claude-mem syncs when the sandbox closes)' : ''),
  );
  return 0;
};

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

export const clean = (ctx: Context): number => {
  const running = isSandboxRunning() ? readSandboxStatus(ctx.dataPath)?.launchId : undefined;
  console.log(
    'Cleanup: ' +
      describePrune(pruneStorage(ctx.storageRoot, { launchDays: ctx.options.days, keep: _.compact([running]) })),
  );
  return 0;
};

const initConfig = (): number => {
  const file = userConfigPath();
  if (fs.existsSync(file)) fail(file + ' already exists.');
  fs.mkdirSync(path.join(userDir(), 'hooks', 'pre-agent'), { recursive: true });
  // The schema sits next to the file (a local path), so editors trust it and show docs and autocomplete.
  writeJson(file, { $schema: './config.schema.json', ...DEFAULTS });
  console.log('Created ' + file + '. It lists every setting with its default; delete the ones you do not change.');
  console.log(
    'Your own hook scripts go in ' + path.join(userDir(), 'hooks') + '\\{pre-provision,pre-agent,post-agent}.',
  );
  console.log("For editor help in every project's .sandbox-config.json, run: sandbox config schema");
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
  console.log('\nThe schema files live in ' + userDir() + ' and are refreshed whenever the sandbox command runs.');
  return 0;
};

/**
 * `sandbox config check`: the folder's .sandbox-config.json validated and described (risky settings flagged, approval
 * state), without launching. Fails with the same message a launch would give when the file is not valid.
 */
const checkLocalConfig = (ctx: Context): number => {
  const dir = path.resolve(ctx.options.workspace ?? process.cwd());
  const file = readLocalConfig(dir);
  if (!file) {
    console.log('No ' + LOCAL_CONFIG_NAME + ' in ' + dir + '; the sandbox uses your own settings only.');
    return 0;
  }
  const overrides = normalizeOverrides(file.data, dir, file.path);
  const approved = isTrusted(trustStorePath(ctx.storageRoot), file.path, file.hash);
  console.log(
    file.path +
      ': valid. ' +
      (approved ? 'Approved (this exact version).' : 'Not approved yet: the next launch asks you.') +
      '\n',
  );
  for (const line of describeOverrides(overrides)) console.log('  ' + safeText(line));
  return 0;
};

export const config = (ctx: Context): number => {
  const [action = 'summary'] = ctx.options.positionals;
  switch (action) {
    case 'summary':
      table([
        [
          'Settings file',
          ctx.loaded.configPath ?? userConfigPath() + '  (does not exist yet; sandbox config init creates it)',
        ],
        ['Default agent', ctx.loaded.config.defaultHarness],
        ['Storage', ctx.storageRoot],
        [
          'Memory',
          String(ctx.loaded.config.sandbox.memoryMb) + (ctx.loaded.config.sandbox.memoryMb === 'auto' ? '' : ' MB'),
        ],
      ]);
      console.log('\nChange settings in the menu (sandbox > Settings). All of them as JSON: sandbox config show');
      return 0;
    case 'path':
      console.log(ctx.loaded.configPath ?? userConfigPath() + '  (does not exist yet)');
      return 0;
    case 'init':
      return initConfig();
    case 'show':
      console.log(JSON.stringify(ctx.loaded.config, null, 2));
      return 0;
    case 'schema':
      return printSchemaSettings();
    case 'check':
      return checkLocalConfig(ctx);
    default:
      fail('Unknown config action "' + action + '".', 'Use one of: sandbox config show | path | init | schema | check');
  }
};

export const doctor = (ctx: Context): number => {
  const rows = doctorRows(
    ctx.loaded.config,
    ctx.options.harness ?? ctx.loaded.config.defaultHarness,
    ctx.storageRoot,
    ctx.loaded.configPath,
  );
  // Inside a sandbox the feature and "running" rows describe the sandbox itself, and the host rows describe nothing useful.
  if (insideSandbox()) {
    table([
      ['Where', 'inside a Windows Sandbox started by this tool (run doctor on your PC to check the PC)'],
      ...rows.filter(([name]) => name === 'Config file'),
    ]);
    return 0;
  }
  // Several projects: the roots mapped at every start, what the running sandbox has, and whether wsb share is there.
  const p = ctx.loaded.config.projects;
  const registry = isSandboxRunning() ? readRegistry(ctx.storageRoot) : null;
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
          readKnown(ctx.storageRoot).length +
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
};

export const claudeHost = (ctx: Context): number =>
  hostClaude(ctx.storageRoot, ctx.options.personal, ctx.options.passthrough);

export const watcher = (ctx: Context): Promise<void> => watch(ctx.dataPath);

const KINDS = ['proc', 'file', 'session', 'guard', 'note'] as const;
const KIND_LABEL: Record<string, string> = {
  proc: 'program',
  file: 'file',
  session: 'session',
  guard: 'GUARD',
  note: 'note',
};

/** `sandbox audit`: the audit log of the last days (audit.enabled), newest last. */
export const audit = async (ctx: Context): Promise<number> => {
  const settings = ctx.loaded.config.audit;
  const kind = ctx.options.kind;
  if (kind && !(KINDS as readonly string[]).includes(kind))
    fail('Unknown kind "' + kind + '".', 'Use one of: ' + KINDS.join(', '));
  const log = new AuditLog(AuditLog.dirFor(ctx.storageRoot, ctx.dataPath), settings);
  const events = log.read({
    days: ctx.options.days,
    kinds: kind ? [kind as (typeof KINDS)[number]] : undefined,
    grep: ctx.options.grep,
  });
  if (printJson(ctx, events)) return 0;
  if (!events.length) {
    console.log(
      settings.enabled
        ? 'Nothing in the audit log for the last ' + ctx.options.days + ' day(s).'
        : 'The audit log is off. Turn it on in the menu (Settings > Security & privacy > Audit log) or with audit.enabled in your config.',
    );
    return 0;
  }
  for (const e of events) {
    // What the sandbox reported is text from the sandbox: no control codes reach your terminal.
    const [p, cmd, parent, dir, act] = [e.p, e.c, e.pp, e.w, e.a].map((v) => plainText(v ?? ''));
    const what =
      e.k === 'proc'
        ? (cmd || p) + (parent ? c.dim('  <- ' + path.win32.basename(parent)) : '')
        : e.k === 'file'
          ? act + ' ' + p + c.dim('  in ' + dir)
          : e.k === 'session'
            ? act + ' ' + p + c.dim('  ' + dir + ' ' + cmd)
            : p;
    console.log(
      c.dim(new Date(e.t).toLocaleString()) +
        '  ' +
        (e.k === 'guard' ? c.yellow(KIND_LABEL[e.k].padEnd(8)) : KIND_LABEL[e.k].padEnd(8)) +
        what +
        (e.n && e.n > 1 ? c.dim('  x' + e.n) : ''),
    );
  }
  console.log(
    c.dim(
      '\n' +
        events.length +
        ' event(s); the log takes ' +
        humanBytes(log.bytes()) +
        ' (' +
        AuditLog.dirFor(ctx.storageRoot, ctx.dataPath) +
        ').',
    ),
  );
  return 0;
};
