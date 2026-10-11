// The interactive menu (`sandbox` with no arguments). Built from manifest.ts: pick a command, answer one question per
// argument and option (on/off options as checkboxes), see the exact command line, run it. The command line it shows is
// what you would type yourself, and the last one is offered again at the top next time.
import fs from 'node:fs';
import path from 'node:path';
import { checkbox, confirm, input, select, Separator } from '@inquirer/prompts';
import { humanBytes } from '../core/disk.js';
import { errMsg, fail } from '../core/util.js';
import { listAccounts } from '../host/accounts.js';
import { runningSessions } from '../host/channel.js';
import { isSandboxRunning } from '../host/platform.js';
import type { Context } from './commands/context.js';
import { cleanTargetOf, collectDataEntries } from './commands/data/collect.js';
import { c, clearScreen, pageSizeFor, shorten, shortenMiddle, termWidth } from './colors.js';
import { commandLine, readHistory } from './history.js';
import { settingsMenu } from './settings/index.js';
import { syncAgentCommands } from './commands/agent-commands.js';
import { loadConfig } from '../core/config.js';
import { askedWhen, COMMANDS, Group, type ArgSpecT, type CommandSpecT, type OptionSpecT } from './manifest.js';
import { askSeveralAgents } from './menu-multi.js';
import { validNodeSpec, validPythonSpec } from './validate.js';

// ---- the screen ------------------------------------------------------------------------------------------------------

/** The settings screen may have switched agentCommands (Beta): apply it now, from the saved file. */
const applyAgentCommands = (ctx: Context): void => {
  try { syncAgentCommands(ctx, loadConfig(ctx.loaded.configPath ?? undefined).config); } catch (e) { console.warn('Agent commands (Beta): ' + errMsg(e)); }
};

/** Waits for one key, so the output of a command stays on screen until you have read it. Ctrl+C leaves. */
const pressAnyKey = (message: string): Promise<void> => new Promise((resolve) => {
  process.stdout.write('\n' + c.dim(message));
  const { stdin } = process;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.once('data', (key: Buffer) => {
    stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write('\n');
    if (key[0] === 3) process.exit(130);
    resolve();
  });
});


// ---- asking for one command ------------------------------------------------------------------------------------------

/** Values for a choices list the manifest names (filled in from config and the running sandbox). */
const choicesFor = (ctx: Context, choices: OptionSpecT['choices']): string[] => {
  if (Array.isArray(choices)) return choices;
  if (choices === 'harnesses') return Object.keys(ctx.loaded.config.harnesses);
  if (choices === 'accounts') return listAccounts(ctx.storageRoot, ctx.dataPath).map((a) => a.name);
  if (choices === 'sessions') return isSandboxRunning() ? runningSessions(ctx.dataPath).map((s) => s.id) : [];
  return [];
};

/** Splits "a b 'c d'" like a shell would (enough for agent arguments and exec commands). */
export const splitArgs = (text: string): string[] => [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

/** What this option accepts, checked while typing (undefined = anything). */
export const optionProblem =(o: OptionSpecT, v: string): string | undefined => {
  if (v === '') return undefined;
  if (o.type === 'number' && !(Number(v) > 0)) return 'Enter a number greater than 0.';
  if (o.flag === '--node' && !validNodeSpec(v)) return 'Use a number like 22 or 22.11.0, or lts, latest.';
  if (o.flag === '--python' && !validPythonSpec(v)) return 'Use 3, 3.12 or 3.12.4.';
  if (o.value === 'dir' && !fs.existsSync(path.resolve(v))) return 'That folder does not exist.';
  if (o.value === 'file') {
    const missing = splitArgs(v).find((f) => !fs.existsSync(path.resolve(f)));
    if (missing) return missing + ' does not exist.';
  }
  return undefined;
};

/** Targets of `data clean` as a checkbox list with sizes (never "all", never --yes: those are typed on purpose). */
const askDataTargets = async (ctx: Context): Promise<string[]> => {
  console.log(c.dim('Measuring the saved data (big folders take a moment)...'));
  const rows = collectDataEntries(ctx.dataPath, ctx.storageRoot).flatMap((e) => { const target = cleanTargetOf(e); return target ? [{ target, bytes: e.bytes }] : []; });
  if (!rows.length) { console.log('Nothing is saved yet, so there is nothing to delete.'); return []; }
  const width = Math.max(...rows.map((r) => r.target.length));
  return checkbox({
    message: 'Delete which? ' + c.dim('(space to tick, enter to continue; you confirm once more)'),
    pageSize: pageSizeFor(16),
    choices: rows.map((r) => ({ name: r.target.padEnd(width) + '  ' + humanBytes(r.bytes).padStart(8), value: r.target, short: r.target })),
    validate: (picked) => (picked.length > 0 ? true : 'Tick at least one with space, or press Ctrl+C to go back.'),
  });
};

const askArg = async (ctx: Context, spec: CommandSpecT, arg: ArgSpecT): Promise<string[]> => {
  if (spec.name === 'data' && arg.name === 'targets') return askDataTargets(ctx);
  const list = choicesFor(ctx, arg.choices);
  if (list.length && !arg.variadic) {
    const picked = await select({ message: arg.description, choices: [...list.map((v) => ({ name: v, value: v })), ...(arg.required ? [] : [{ name: c.dim('(skip)'), value: '' }])] });
    return picked ? [picked] : [];
  }
  // A list the manifest fills in at run time (saved accounts, running sessions) that is empty: nothing to pick, so do not ask.
  if (typeof arg.choices === 'string' && !arg.required) return [];
  if (typeof arg.choices === 'string') fail('There is nothing to choose from: no ' + arg.choices + ' yet.', arg.choices === 'accounts' ? 'Sign in inside the sandbox, then run: sandbox account save <name>' : 'Start one first (sandbox claude).');
  const answer = await input({ message: arg.description + (arg.required ? '' : c.dim(' (optional)')), validate: (v) => (!arg.required || v.trim() !== '' ? true : 'This is required.') });
  return arg.variadic ? splitArgs(answer) : answer.trim() ? [answer.trim()] : [];
};

const askOptions = async (ctx: Context, options: OptionSpecT[]): Promise<string[]> => {
  const argv: string[] = [];
  const flags = options.filter((o) => o.type === 'boolean');
  if (flags.length) argv.push(...await checkbox({ message: 'Options ' + c.dim('(space to toggle, enter to continue)'), choices: flags.map((o) => ({ name: o.flag + c.dim('  ' + shorten(o.description, Math.max(20, termWidth() - o.flag.length - 8))), value: o.flag })) }));
  for (const o of options.filter((x) => x.type !== 'boolean')) {
    const list = choicesFor(ctx, o.choices);
    const label = o.flag + c.dim('  ' + o.description);
    // A named list that is empty (no saved accounts) has nothing to pick: leave the option out.
    if (typeof o.choices === 'string' && !list.length) continue;
    if (o.type === 'list' && list.length) {
      for (const v of await checkbox({ message: label, choices: list.map((v) => ({ name: v, value: v })) })) argv.push(o.flag, v);
      continue;
    }
    const value = list.length
      ? await select({ message: label, choices: [{ name: c.dim('(default' + (o.choices === 'harnesses' ? ': ' + ctx.loaded.config.defaultHarness : o.choices === 'accounts' ? ': none chosen' : '') + ')'), value: '' }, ...list.map((v) => ({ name: v, value: v }))] })
      : await input({ message: label + c.dim(o.default !== undefined ? ' (default ' + o.default + ')' : ' (empty = default)'), validate: (v) => optionProblem(o, v) ?? true });
    if (!value) continue;
    for (const v of o.type === 'list' ? splitArgs(value) : [value]) argv.push(o.flag, v);
  }
  return argv;
};

/** Asks everything a command takes and returns its argv (or null when the user backs out). */
export const askCommand = async (ctx: Context, spec: CommandSpecT, preset: string[] = []): Promise<string[] | null> => {
  console.log('\n' + c.bold(spec.name) + c.dim('  ' + shorten(spec.summary, termWidth() - spec.name.length - 3)));
  const argv = [spec.name, ...preset];
  // The common case needs one answer: start with the settings you already have, or change them first.
  if (spec.name === 'launch' && preset.length) {
    const quick = await select({ message: 'Start ' + (preset[preset.indexOf('--harness') + 1] ?? 'the agent') + ' in ' + shortenMiddle(process.cwd(), Math.max(20, termWidth() - 30)), choices: [{ name: 'Start now', value: 'now' }, { name: 'Change options first...', value: 'custom' }, { name: c.dim('< back'), value: 'back' }] });
    if (quick === 'back') return null;
    if (quick === 'now') { console.log(c.dim('  ' + commandLine(argv))); return argv; }
  }
  let first = '';
  for (const [i, arg] of spec.args.entries()) {
    if (!askedWhen(arg.when, first)) continue;
    const answer = await askArg(ctx, spec, arg);
    if (i === 0) first = answer[0] ?? '';
    argv.push(...answer);
  }
  const offered = (o: OptionSpecT): boolean => !o.noMenu && askedWhen(o.when, first);
  const basic = spec.options.filter((o) => !o.advanced && !preset.includes(o.flag) && offered(o));
  const advanced = spec.options.filter((o) => o.advanced && offered(o));
  argv.push(...await askOptions(ctx, basic));
  if (advanced.length && await confirm({ message: 'Change advanced options (' + advanced.map((o) => o.flag).join(', ') + ')?', default: false })) argv.push(...await askOptions(ctx, advanced));
  if (spec.json && !(spec.name === 'data' && first === 'clean') && await confirm({ message: 'Machine-readable output (--json)?', default: false })) argv.push('--json');
  if (spec.passthrough) {
    const extra = splitArgs(await input({ message: spec.passthrough === 'agent' ? 'Extra arguments for the agent ' + c.dim('(optional, e.g. --continue)') : 'Arguments for the command' + c.dim(' (optional)') }));
    if (extra.length) argv.push(...(spec.passthrough === 'agent' ? ['--', ...extra] : extra));
  }
  console.log(c.dim('  ' + commandLine(argv)));
  return await confirm({ message: 'Run it?', default: true }) ? argv : null;
};


// ---- the menu --------------------------------------------------------------------------------------------------------

/** Is this agent already in the sandbox's persistent storage (so starting it needs no install)? */
const agentInstalled = (ctx: Context, name: string): boolean => {
  const h = ctx.loaded.config.harnesses[name];
  const dir = path.join(ctx.dataPath, 'tools', 'agents', name);
  return Boolean(h) && [h.hostExecutable, h.npmBin && h.npmBin + '.cmd', h.uvBin && h.uvBin + '.exe'].some((f) => f && fs.existsSync(path.join(dir, f)));
};

type Pick = { kind: 'run'; argv: string[] } | { kind: 'several' } |{ kind: 'ask'; spec: CommandSpecT; preset?: string[] } | { kind: 'group'; group: string } | { kind: 'exit' };

const GROUP_TITLES: Record<string, string> = { Agents: 'Start an agent', Sandbox: 'Sandbox', Sessions: 'Sessions', Accounts: 'Claude accounts', Data: 'Saved data and cleanup', Health: 'Diagnostics and repair', Config: 'Configuration' };

const pickAgent = async (ctx: Context): Promise<Pick> => {
  const names = Object.keys(ctx.loaded.config.harnesses);
  clearScreen();
  const name = await select({
    message: 'Which agent?',
    pageSize: pageSizeFor(16),
    choices: [
      ...names.map((n) => ({ name: n.padEnd(10) + (agentInstalled(ctx, n) ? c.green(' installed') : c.dim(' installs on first start')) + (n === ctx.loaded.config.defaultHarness ? c.dim('  (default)') : ''), value: n })),
      new Separator(),
      { name: 'Claude on this PC, NOT sandboxed (host-claude)', value: '@host' },
      { name: c.dim('< back'), value: '' },
    ],
  });
  if (name === '@host') return { kind: 'ask', spec: COMMANDS.find((s) => s.name === 'host-claude')! };
  return name ? { kind: 'ask', spec: COMMANDS.find((s) => s.name === 'launch')!, preset: ['--harness', name] } : { kind: 'group', group: '' };
};

const mainMenu = async (ctx: Context): Promise<Pick> => {
  const last = readHistory()[0];
  const running = isSandboxRunning();
  clearScreen();
  console.log(c.bold(c.cyan('Windows Development Sandbox')) + c.dim('  ' + shortenMiddle(process.cwd(), Math.max(20, termWidth() - 32))) + '\n' + (running ? c.green('  A sandbox is running') + c.dim(' (' + runningSessions(ctx.dataPath).length + ' session(s))') : c.dim('  No sandbox running')) + '\n');
  return select<Pick>({
    message: 'What would you like to do?',
    pageSize: pageSizeFor(14),
    choices: [
      ...(last ? [{ name: 'Repeat last: ' + c.cyan(shorten(commandLine(last.argv), Math.max(20, termWidth() - 20))), value: { kind: 'run', argv: last.argv } as Pick }] : []),
      { name: 'Start ' + ctx.loaded.config.defaultHarness + ' in this folder', value: { kind: 'ask', spec: COMMANDS.find((s) => s.name === 'launch')!, preset: ['--harness', ctx.loaded.config.defaultHarness] } },
      { name: 'Start several agents (one or more projects, attach to any)...', value: { kind: 'several' } },
      { name: 'Start another agent...', value: { kind: 'group', group: '@agents' } },
      { name: 'Start a sandbox without an agent', value: { kind: 'ask', spec: COMMANDS.find((s) => s.name === 'start')! } },
      new Separator(),
      ...Group.options.filter((g) => g !== 'Agents').map((g) => ({ name: GROUP_TITLES[g] + '...', value: { kind: 'group', group: g } as Pick })),
      { name: 'Settings ' + c.dim('(every setting, saved to your config file)'), value: { kind: 'group', group: '@settings' } },
      new Separator(),
      { name: 'Exit', value: { kind: 'exit' } },
    ],
  });
};

const groupMenu = async (group: string): Promise<Pick> => {
  clearScreen();
  return select<Pick>({
    message: GROUP_TITLES[group] ?? group,
    pageSize: pageSizeFor(16),
    choices: [
      ...COMMANDS.filter((s) => s.group === group && !s.hidden).map((s) => ({ name: s.name.padEnd(10), description: s.summary, value: { kind: 'ask', spec: s } as Pick })),
      { name: c.dim('< back'), value: { kind: 'group', group: '' } },
    ],
  });
};

/**
 * Runs the menu until Exit, or until a command that takes over the terminal (launch, attach) has run. `run` executes
 * an argv exactly like typing it.
 */
export const menu = async (ctx: Context, run: (argv: string[]) => Promise<number>): Promise<number> => {
  if (!process.stdin.isTTY) { console.log('The menu needs an interactive terminal. Run sandbox --help for the commands.'); return 1; }
  try {
    for (let pick = await mainMenu(ctx); ;) {
      if (pick.kind === 'exit') return 0;
      if (pick.kind === 'group' && pick.group === '@settings') { await settingsMenu(ctx.loaded.configPath); applyAgentCommands(ctx); pick = await mainMenu(ctx); }
      else if (pick.kind === 'group') pick = pick.group === '' ? await mainMenu(ctx) : pick.group === '@agents' ? await pickAgent(ctx) : await groupMenu(pick.group);
      else {
        // Ctrl+C while answering the questions of one command goes back to the menu; on the menu itself it leaves.
        let argv: string[] | null;
        try {
          clearScreen();
          argv = pick.kind === 'run' ? pick.argv : pick.kind === 'several' ? await askSeveralAgents(ctx) : await askCommand(ctx, pick.spec, pick.preset);
        } catch (e) {
          if (e instanceof Error && e.name === 'ExitPromptError') argv = null; else throw e;
        }
        if (!argv) { pick = await mainMenu(ctx); continue; }
        clearScreen();
        console.log(c.dim('$ ' + commandLine(argv)) + '\n');
        const code = await run(argv);
        if (COMMANDS.find((s) => s.name === argv[0])?.interactive) return code;
        await pressAnyKey((code === 0 ? c.green('Done.') : yellowCode(code)) + ' Press any key for the menu...');
        pick = await mainMenu(ctx);
      }
    }
  } catch (e) {
    // Ctrl+C in a prompt: leave quietly.
    if (e instanceof Error && e.name === 'ExitPromptError') return 130;
    throw e;
  }
};

const yellowCode = (code: number): string => c.yellow('Exit code ' + code);
