// The interactive menu (`sandbox` with no arguments). Built from manifest.ts: pick a command, answer one question per
// argument and option (on/off options as checkboxes), see the exact command line, run it. The command line it shows is
// what you would type yourself, and the last one is offered again at the top next time.
import fs from 'node:fs';
import path from 'node:path';
import { checkbox, confirm, input, select, Separator } from '@inquirer/prompts';
import { z } from 'zod';
import { userDir } from '../core/config.js';
import { tryReadJson, writeJson } from '../core/util.js';
import { listAccounts } from '../host/accounts.js';
import { runningSessions } from '../host/channel.js';
import { isSandboxRunning } from '../host/platform.js';
import type { Context } from './commands/context.js';
import { COMMANDS, Group, type ArgSpecT, type CommandSpecT, type OptionSpecT } from './manifest.js';

const c = { bold: (s: string) => '\x1b[1m' + s + '\x1b[0m', dim: (s: string) => '\x1b[2m' + s + '\x1b[0m', cyan: (s: string) => '\x1b[36m' + s + '\x1b[0m', green: (s: string) => '\x1b[32m' + s + '\x1b[0m', yellow: (s: string) => '\x1b[33m' + s + '\x1b[0m' };

// ---- history ---------------------------------------------------------------------------------------------------------

const History = z.array(z.strictObject({ argv: z.array(z.string()).max(200), at: z.string() })).max(20);
const historyFile = (): string => path.join(userDir(), 'history.json');
const HIDDEN = new Set(['menu', '_watch', 'self-test']);

export const readHistory = (): z.output<typeof History> => History.safeParse(tryReadJson(historyFile())).data ?? [];

/** Remembers a command (menu or typed) so the menu can offer it again. Never fails the command itself. */
export const recordHistory = (argv: string[]): void => {
  if (!argv.length || HIDDEN.has(argv[0]) || argv.includes('--help')) return;
  try { writeJson(historyFile(), [{ argv, at: new Date().toISOString() }, ...readHistory().filter((h) => h.argv.join('\0') !== argv.join('\0'))].slice(0, 10)); } catch { /* history is a convenience */ }
};

/** argv as you would type it (quoted where needed). */
export const commandLine = (argv: string[]): string => ['sandbox', ...argv].map((a) => (/[\s"]/.test(a) || a === '' ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(' ');

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

const askArg = async (ctx: Context, arg: ArgSpecT): Promise<string[]> => {
  const list = choicesFor(ctx, arg.choices);
  if (list.length && !arg.variadic) {
    const picked = await select({ message: arg.description, choices: [...list.map((v) => ({ name: v, value: v })), ...(arg.required ? [] : [{ name: c.dim('(skip)'), value: '' }])] });
    return picked ? [picked] : [];
  }
  const answer = await input({ message: arg.description + (arg.required ? '' : c.dim(' (optional)')), validate: (v) => (!arg.required || v.trim() !== '' ? true : 'required') });
  return arg.variadic ? splitArgs(answer) : answer.trim() ? [answer.trim()] : [];
};

const askOptions = async (ctx: Context, options: OptionSpecT[]): Promise<string[]> => {
  const argv: string[] = [];
  const flags = options.filter((o) => o.type === 'boolean');
  if (flags.length) argv.push(...await checkbox({ message: 'Options ' + c.dim('(space to toggle, enter to continue)'), choices: flags.map((o) => ({ name: o.flag + c.dim('  ' + o.description), value: o.flag })) }));
  for (const o of options.filter((x) => x.type !== 'boolean')) {
    const list = choicesFor(ctx, o.choices);
    const label = o.flag + c.dim('  ' + o.description);
    const value = list.length
      ? await select({ message: label, choices: [{ name: c.dim('(default)'), value: '' }, ...list.map((v) => ({ name: v, value: v }))] })
      : await input({ message: label + c.dim(o.default !== undefined ? ' (default ' + o.default + ')' : ' (empty = default)'), validate: (v) => (o.type !== 'number' || v === '' || Number(v) > 0 ? true : 'a positive number') });
    if (!value) continue;
    for (const v of o.type === 'list' ? splitArgs(value) : [value]) argv.push(o.flag, v);
  }
  return argv;
};

/** Asks everything a command takes and returns its argv (or null when the user backs out). */
export const askCommand = async (ctx: Context, spec: CommandSpecT, preset: string[] = []): Promise<string[] | null> => {
  console.log('\n' + c.bold(spec.name) + c.dim('  ' + spec.summary));
  const argv = [spec.name, ...preset];
  for (const arg of spec.args) argv.push(...await askArg(ctx, arg));
  const basic = spec.options.filter((o) => !o.advanced && !preset.includes(o.flag));
  const advanced = spec.options.filter((o) => o.advanced);
  argv.push(...await askOptions(ctx, basic));
  if (advanced.length && await confirm({ message: 'Change advanced options (' + advanced.map((o) => o.flag).join(', ') + ')?', default: false })) argv.push(...await askOptions(ctx, advanced));
  if (spec.json && await confirm({ message: 'Machine-readable output (--json)?', default: false })) argv.push('--json');
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

type Pick = { kind: 'run'; argv: string[] } | { kind: 'ask'; spec: CommandSpecT; preset?: string[] } | { kind: 'group'; group: string } | { kind: 'exit' };

const GROUP_TITLES: Record<string, string> = { Agents: 'Start an agent', Sandbox: 'Sandbox', Sessions: 'Sessions (attach, restart)', Accounts: 'Claude accounts', Data: 'Persisted data, sync and cleanup', Health: 'Diagnostics and repair (doctor, setup, repair, dry run, logs)', Config: 'Configuration' };

const pickAgent = async (ctx: Context): Promise<Pick> => {
  const names = Object.keys(ctx.loaded.config.harnesses);
  const name = await select({
    message: 'Which agent?',
    pageSize: 16,
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
  console.log('\n' + c.bold(c.cyan('Windows Development Sandbox')) + c.dim('  ' + process.cwd()) + '\n' + (running ? c.green('  A sandbox is running') + c.dim(' (' + runningSessions(ctx.dataPath).length + ' session(s))') : c.dim('  No sandbox running')));
  return select<Pick>({
    message: 'What would you like to do?',
    pageSize: 14,
    choices: [
      ...(last ? [{ name: 'Repeat last: ' + c.cyan(commandLine(last.argv)), value: { kind: 'run', argv: last.argv } as Pick }] : []),
      { name: 'Start ' + ctx.loaded.config.defaultHarness + ' in this folder', value: { kind: 'ask', spec: COMMANDS.find((s) => s.name === 'launch')!, preset: ['--harness', ctx.loaded.config.defaultHarness] } },
      { name: 'Start another agent...', value: { kind: 'group', group: '@agents' } },
      { name: 'Start a sandbox without an agent', value: { kind: 'ask', spec: COMMANDS.find((s) => s.name === 'start')! } },
      new Separator(),
      ...Group.options.filter((g) => g !== 'Agents').map((g) => ({ name: GROUP_TITLES[g] + '...', value: { kind: 'group', group: g } as Pick })),
      new Separator(),
      { name: 'Exit', value: { kind: 'exit' } },
    ],
  });
};

const groupMenu = async (group: string): Promise<Pick> => select<Pick>({
  message: GROUP_TITLES[group] ?? group,
  pageSize: 16,
  choices: [
    ...COMMANDS.filter((s) => s.group === group && !s.hidden).map((s) => ({ name: s.name.padEnd(10) + c.dim(' ' + s.summary), value: { kind: 'ask', spec: s } as Pick })),
    { name: c.dim('< back'), value: { kind: 'group', group: '' } },
  ],
});

/**
 * Runs the menu until Exit, or until a command that takes over the terminal (launch, attach) has run. `run` executes
 * an argv exactly like typing it.
 */
export const menu = async (ctx: Context, run: (argv: string[]) => Promise<number>): Promise<number> => {
  if (!process.stdin.isTTY) { console.log('The menu needs an interactive terminal. Run sandbox --help for the commands.'); return 1; }
  try {
    for (let pick = await mainMenu(ctx); ;) {
      if (pick.kind === 'exit') return 0;
      if (pick.kind === 'group') pick = pick.group === '' ? await mainMenu(ctx) : pick.group === '@agents' ? await pickAgent(ctx) : await groupMenu(pick.group);
      else {
        const argv = pick.kind === 'run' ? pick.argv : await askCommand(ctx, pick.spec, pick.preset);
        if (!argv) { pick = await mainMenu(ctx); continue; }
        const code = await run(argv);
        if (COMMANDS.find((s) => s.name === argv[0])?.interactive) return code;
        await input({ message: c.dim((code === 0 ? 'Done' : yellowCode(code)) + '. Press Enter for the menu') });
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
