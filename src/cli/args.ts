// Command-line parsing with commander. parseCli() only parses (no side effects), so it is easy to test; cli/index.ts
// dispatches the result. sandbox claude & co parse as `launch`: every option launch does not own goes to the agent, in order.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError, Option } from 'commander';
import { z } from 'zod';
import { fail, tryReadJson } from '../core/util.js';
import { c } from './colors.js';
import { COMMANDS, type OptionSpecT } from './manifest.js';

export interface CliOptions {
  command: string; positionals: string[]; passthrough: string[];
  config?: string; workspace?: string; harness?: string; account?: string; node?: string; python?: string;
  scripts: string[]; databases: string[]; headless?: boolean; terminal: boolean; newSession: boolean; noAgent: boolean; trustConfig: boolean; noLocalConfig: boolean;
  personal: boolean; fromHost: boolean; noRestart: boolean; follow: boolean; json: boolean; yes: boolean; timeout: number; days: number;
  /** restart: every session, not only this folder's project's. */
  all: boolean;
  /** launch --session <agent>@<folder> (repeatable): several sessions at once, folders made absolute. */
  sessions: SessionWant[];
}

/** One session to start: an agent in a folder. */
export interface SessionWant { harness: string; folder: string }

/**
 * `<agent>@<folder>` (the folder may contain '@': only the first one splits), `<agent>` alone = the current folder.
 * Folders become absolute against `cwd`. Pure; validate.ts checks that the agent and folder exist.
 */
export const parseSessionWant = (text: string, cwd: string = process.cwd()): SessionWant => {
  const at = text.indexOf('@');
  const harness = (at < 0 ? text : text.slice(0, at)).trim();
  const folder = at < 0 ? '' : text.slice(at + 1).trim();
  if (!harness) fail('--session "' + text + '" names no agent.', 'Use --session <agent>@<folder>, e.g. --session claude@C:\\code\\api (the folder defaults to this one).');
  return { harness, folder: path.resolve(cwd, folder || '.') };
};

/** This package's version (this file is dist/cli/args.js, two folders below package.json). */
export const packageVersion = (): string => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  return z.object({ version: z.string() }).safeParse(tryReadJson(file)).data?.version ?? 'unknown';
};

/** Reserved spelling for our launch options that can never clash with an agent's flags: --sbx-terminal, ... */
const SBX_PREFIX = '--sbx-';

const positiveNumber = (value: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('expected a positive number');
  return n;
};
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** One commander option from its manifest entry. */
const toOption = (o: OptionSpecT): Option => {
  const flags = (o.short ? o.short + ', ' : '') + o.flag + (o.type === 'boolean' ? '' : ' <' + (o.value ?? 'value') + '>');
  const option = new Option(flags, o.description);
  if (o.type === 'number') option.argParser(positiveNumber);
  if (o.type === 'list') option.argParser(collect);
  if (o.default !== undefined) option.default(o.default);
  return option;
};

/** Every command, its options and help text, from manifest.ts. Actions only record what was parsed. */
export const buildProgram = (record: (name: string, cmd: Command) => void): Command => {
  const program = new Command('sandbox')
    .description('A disposable Windows Sandbox for development, with or without an AI agent, for the folder you are in. Run it with no arguments for the menu.')
    .version(packageVersion(), '-v, --version', 'show the version')
    .enablePositionalOptions()
    .showHelpAfterError('  Fix:  run the command with --help to see how to use it.')
    .configureOutput({ outputError: (text, write) => write(c.red('Error: ') + text.replace(/^error: /, '').replace(/^./, (ch) => ch.toUpperCase())) })
    .addHelpText('after', '\nPut --config <file> before or after the command to use another settings file.\nExamples:\n  sandbox                       the menu\n  sandbox claude -t             start Claude and attach this terminal\n  sandbox data clean logs       delete the saved logs\n  sandbox exec -- npm test      run a command in the running sandbox')
    .exitOverride();
  for (const spec of COMMANDS) {
    const cmd = program.command(spec.name, { hidden: spec.hidden }).description(spec.summary).option('--config <file>', 'config file (default: ~/.agent-sandbox/config.json)');
    for (const option of spec.options) cmd.addOption(toOption(option));
    if (spec.json) cmd.option('--json', 'machine-readable output');
    for (const arg of spec.args) cmd.argument((arg.required ? '<' : '[') + arg.name + (arg.variadic ? '...' : '') + (arg.required ? '>' : ']'), arg.description);
    if (spec.passthrough === 'agent') cmd.argument('[agentArgs...]', 'passed to the agent').allowUnknownOption().allowExcessArguments();
    if (spec.passthrough === 'command') cmd.passThroughOptions();
    cmd.action((...args: unknown[]) => record(spec.name, args[args.length - 1] as Command));
  }
  return program;
};

/** Turns `--sbx-<option>` into `--<option>` (only for options launch knows; anything else is an error). */
const expandReserved = (argv: string[], known: Set<string>): string[] => {
  const end = argv.indexOf('--');
  return argv.map((token, i) => {
    if ((end !== -1 && i > end) || !token.startsWith(SBX_PREFIX)) return token;
    const [flag, value] = token.split(/=(.*)/s);
    const option = '--' + flag.slice(SBX_PREFIX.length);
    if (!known.has(option)) fail('Unknown option: ' + flag, 'Reserved --sbx- options: ' + [...known].map((o) => o.replace('--', SBX_PREFIX)).join(', '));
    return value === undefined ? option : option + '=' + value;
  });
};

/** Parses argv into the command name and options. Throws commander errors for unknown commands/options. */
export const parseCli = (argv: string[], wrapper = false): CliOptions => {
  let parsed: { name: string; cmd: Command } | null = null;
  const program = buildProgram((name, cmd) => { parsed = { name, cmd }; });
  const launchFlags = new Set(program.commands.find((c) => c.name() === 'launch')!.options.map((o) => o.long!).filter(Boolean));
  const args = expandReserved(wrapper ? ['launch', ...argv] : argv, launchFlags);
  program.parse(args, { from: 'user' });
  if (!parsed) return { ...defaults(), command: '' };
  const { name, cmd } = parsed as { name: string; cmd: Command };
  const o = { ...program.opts(), ...cmd.opts() } as Record<string, unknown>;
  const forAgent = ['launch', 'start', 'generate', 'host-claude'].includes(name);
  // Commander keeps our `--` separator among the operands when unknown options are allowed; it is ours, not the agent's.
  const separator = forAgent ? cmd.args.indexOf('--') : -1;
  const operands = separator === -1 ? cmd.args : [...cmd.args.slice(0, separator), ...cmd.args.slice(separator + 1)];
  return {
    ...defaults(),
    // `start` is launch without an agent.
    command: name === 'start' ? 'launch' : name,
    positionals: forAgent || name === 'exec' ? [] : operands,
    passthrough: forAgent || name === 'exec' ? operands : [],
    config: o.config as string | undefined,
    workspace: o.workspace as string | undefined,
    harness: o.harness as string | undefined,
    account: o.account as string | undefined,
    node: o.node as string | undefined,
    python: o.python as string | undefined,
    scripts: (o.script as string[] | undefined) ?? [],
    databases: ((o.database as string[] | undefined) ?? []).flatMap((d) => d.split(',')).map((d) => d.trim()).filter(Boolean),
    headless: o.window ? false : o.headless ? true : undefined,
    terminal: Boolean(o.terminal),
    newSession: Boolean(o.new),
    noAgent: o.agent === false || name === 'start',
    trustConfig: Boolean(o.trustConfig),
    noLocalConfig: o.localConfig === false,
    personal: Boolean(o.personal),
    fromHost: Boolean(o.fromHost),
    noRestart: o.restart === false,
    follow: Boolean(o.follow),
    json: Boolean(o.json),
    yes: Boolean(o.yes),
    all: Boolean(o.all),
    sessions: ((o.session as string[] | undefined) ?? []).map((s) => parseSessionWant(s)),
    timeout: (o.timeout as number | undefined) ?? 600,
    days: (o.days as number | undefined) ?? 7,
  };
};

const defaults = (): CliOptions => ({
  command: '', positionals: [], passthrough: [], scripts: [], databases: [], terminal: false, newSession: false, noAgent: false, trustConfig: false, noLocalConfig: false,
  personal: false, fromHost: false, noRestart: false, follow: false, json: false, yes: false, all: false, sessions: [], timeout: 600, days: 7,
});
