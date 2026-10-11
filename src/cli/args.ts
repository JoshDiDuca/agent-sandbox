// Command-line parsing with commander. parseCli() only parses (no side effects), so it is easy to test; cli/index.ts
// dispatches the result. claude-sbx & co parse as `launch`: every option launch does not own goes to the agent, in order.
import { Command, InvalidArgumentError, Option } from 'commander';
import { fail } from '../core/util.js';

export interface CliOptions {
  command: string; positionals: string[]; passthrough: string[];
  config?: string; workspace?: string; harness?: string; account?: string; node?: string; python?: string;
  scripts: string[]; headless?: boolean; terminal: boolean; noAgent: boolean; trustConfig: boolean; noLocalConfig: boolean;
  personal: boolean; fromHost: boolean; noRestart: boolean; follow: boolean; json: boolean; timeout: number; days: number;
}

/** Reserved spelling for our launch options that can never clash with an agent's flags: --sbx-terminal, ... */
const SBX_PREFIX = '--sbx-';

const positiveNumber = (value: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('expected a positive number');
  return n;
};
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

const withLaunchOptions = (cmd: Command): Command => cmd
  .option('-t, --terminal', 'run the agent in THIS terminal (attaches if a sandbox is already running)')
  .addOption(new Option('--headless', 'hide the sandbox window (sbx-show brings it back)'))
  .addOption(new Option('--window', 'show the sandbox window even if config says headless'))
  .option('--account <name>', 'Claude account to use for this sandbox')
  .option('--node <version>', 'Node version for nvm (default: .sandbox-config.json > .nvmrc > this PC)')
  .option('--python <version>', 'Python 3 version (default: .sandbox-config.json > .python-version > config)')
  .option('--workspace <dir>', 'use this folder instead of the current one')
  .option('--harness <name>', 'agent to run: claude | codex | gemini | ...')
  .option('--script <file>', 'run this .ps1/.mjs/.cmd inside the sandbox before the agent (repeatable)', collect)
  .option('--no-agent', 'provision the sandbox without starting an agent')
  .option('--trust-config', 'approve the folder\'s .sandbox-config.json without asking')
  .option('--no-local-config', 'ignore the folder\'s .sandbox-config.json');

const jsonOption = (cmd: Command): Command => cmd.option('--json', 'machine-readable output');

/** Every command, its options and help text. Actions only record what was parsed. */
export const buildProgram = (record: (name: string, cmd: Command) => void): Command => {
  const program = new Command('agent-sandbox')
    .description('Run Claude Code (or Codex / Gemini) in Windows Sandbox with the current folder as its workspace.')
    .enablePositionalOptions()
    .showHelpAfterError('(run with --help for usage)')
    .exitOverride();
  const add = (name: string, description: string, build: (cmd: Command) => Command = (c) => c): Command =>
    build(program.command(name).description(description).option('--config <file>', 'config file (default: ~/.agent-sandbox/config.json)')).action((...args: unknown[]) => record(name, args[args.length - 1] as Command));

  add('launch', 'start the sandbox and the agent (or another session in the running sandbox)', (c) => withLaunchOptions(c).argument('[agentArgs...]').allowUnknownOption().allowExcessArguments());
  add('generate', 'write the .wsb and launch folder without starting anything', (c) => withLaunchOptions(c).argument('[agentArgs...]').allowUnknownOption().allowExcessArguments());
  add('attach', 'show a running session in this terminal (Ctrl+] detaches)', (c) => c.argument('[id]'));
  add('sessions', 'list agent sessions', jsonOption);
  add('status', 'sandbox overview', jsonOption);
  add('exec', 'run a command inside the sandbox and print its output', (c) => jsonOption(c).option('--timeout <seconds>', 'give up after this many seconds', positiveNumber, 600).option('--workspace <dir>', 'folder (inside the mapped workspace) to run in').argument('<command...>').passThroughOptions());
  add('restart', 'restart running agents in place; they resume their conversation', (c) => c.option('--harness <name>', 'only this agent'));
  add('stop', 'shut the sandbox down');
  add('show', 'show the sandbox window');
  add('hide', 'hide the sandbox window');
  add('account', 'Claude accounts: list | save <name> | use <name> | default <name> | remove <name>', (c) => jsonOption(c).argument('[action]').argument('[name]').option('--from-host', '(save) save this PC\'s login instead of the sandbox\'s').option('--no-restart', '(use) do not restart running sessions'));
  add('sync', 'copy history (and claude-mem, once closed) back to this PC now');
  add('logs', 'print the newest sandbox log', (c) => c.option('-f, --follow', 'keep printing new lines'));
  add('clean', 'delete old launch folders, logs and leftovers', (c) => c.option('--days <n>', 'launch folders older than this many days', positiveNumber, 7));
  add('config', 'show | path | init', (c) => c.argument('[action]'));
  add('doctor', 'check this PC and show what will be copied or downloaded', (c) => c.option('--harness <name>', 'agent to check'));
  add('host-claude', 'Claude on this PC (NOT sandboxed) with a separate profile', (c) => c.option('--personal', 'use your normal Claude profile').argument('[claudeArgs...]').allowUnknownOption().allowExcessArguments());
  add('self-test', 'run the built-in tests');
  program.command('_watch', { hidden: true }).action((...args: unknown[]) => record('_watch', args[args.length - 1] as Command));
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
  const forAgent = ['launch', 'generate', 'host-claude'].includes(name);
  // Commander keeps our `--` separator among the operands when unknown options are allowed; it is ours, not the agent's.
  const separator = forAgent ? cmd.args.indexOf('--') : -1;
  const operands = separator === -1 ? cmd.args : [...cmd.args.slice(0, separator), ...cmd.args.slice(separator + 1)];
  return {
    ...defaults(),
    command: name,
    positionals: forAgent || name === 'exec' ? [] : operands,
    passthrough: forAgent || name === 'exec' ? operands : [],
    config: o.config as string | undefined,
    workspace: o.workspace as string | undefined,
    harness: o.harness as string | undefined,
    account: o.account as string | undefined,
    node: o.node as string | undefined,
    python: o.python as string | undefined,
    scripts: (o.script as string[] | undefined) ?? [],
    headless: o.window ? false : o.headless ? true : undefined,
    terminal: Boolean(o.terminal),
    noAgent: o.agent === false,
    trustConfig: Boolean(o.trustConfig),
    noLocalConfig: o.localConfig === false,
    personal: Boolean(o.personal),
    fromHost: Boolean(o.fromHost),
    noRestart: o.restart === false,
    follow: Boolean(o.follow),
    json: Boolean(o.json),
    timeout: (o.timeout as number | undefined) ?? 600,
    days: (o.days as number | undefined) ?? 7,
  };
};

const defaults = (): CliOptions => ({
  command: '', positionals: [], passthrough: [], scripts: [], terminal: false, noAgent: false, trustConfig: false, noLocalConfig: false,
  personal: false, fromHost: false, noRestart: false, follow: false, json: false, timeout: 600, days: 7,
});
