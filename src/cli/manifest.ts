// Every command, defined once: name, group, arguments and options with their types. args.ts builds the commander
// parser from it and menu.ts builds the interactive menu from it, so a command added here works both ways.
import { z } from 'zod';

const Choices = z.union([z.array(z.string()), z.enum(['harnesses', 'accounts', 'sessions'])])
  .describe('Fixed values, or a list the menu fills in at run time.');

export const OptionSpec = z.strictObject({
  flag: z.string().regex(/^--[a-z][a-z0-9-]*$/).describe('Long flag, e.g. --terminal.'),
  short: z.string().regex(/^-[a-zA-Z]$/).optional(),
  type: z.enum(['boolean', 'string', 'number', 'list']).describe('list = repeatable string option.'),
  value: z.string().optional().describe('Placeholder shown in help, e.g. name for --account <name>.'),
  description: z.string(),
  default: z.union([z.string(), z.number()]).optional(),
  choices: Choices.optional(),
  /** Advanced options are only asked in the menu after "Show advanced options". */
  advanced: z.boolean().optional(),
});

export const ArgSpec = z.strictObject({
  name: z.string(),
  description: z.string(),
  required: z.boolean(),
  variadic: z.boolean().optional(),
  choices: Choices.optional(),
});

export const Group = z.enum(['Agents', 'Sandbox', 'Sessions', 'Accounts', 'Data', 'Health', 'Config']);

export const CommandSpec = z.strictObject({
  name: z.string(),
  summary: z.string(),
  group: Group,
  args: z.array(ArgSpec),
  options: z.array(OptionSpec),
  /** Unknown options and extra arguments are passed on to the agent (launch) or the program (exec). */
  passthrough: z.enum(['agent', 'command']).optional(),
  json: z.boolean().optional(),
  /** Takes over the terminal or ends the session: the menu does not come back afterwards. */
  interactive: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

export type OptionSpecT = z.output<typeof OptionSpec>;
export type ArgSpecT = z.output<typeof ArgSpec>;
export type CommandSpecT = z.output<typeof CommandSpec>;

const bool = (flag: string, description: string, extra: Partial<OptionSpecT> = {}): OptionSpecT => ({ flag, type: 'boolean', description, ...extra });
const text = (flag: string, value: string, description: string, extra: Partial<OptionSpecT> = {}): OptionSpecT => ({ flag, type: 'string', value, description, ...extra });

const SANDBOX_OPTIONS: OptionSpecT[] = [
  bool('--terminal', 'run in THIS terminal (reattaches to this folder\'s session if nobody is watching it)', { short: '-t' }),
  bool('--headless', 'hide the sandbox window (sbx-show brings it back)'),
  bool('--new', 'always start a new session, even if this folder has one nobody is attached to'),
  text('--workspace', 'dir', 'use this folder instead of the current one'),
  text('--node', 'version', 'Node version for nvm (default: .sandbox-config.json > .nvmrc > this PC)', { advanced: true }),
  text('--python', 'version', 'Python 3 version (default: .sandbox-config.json > .python-version > config)', { advanced: true }),
  { flag: '--script', type: 'list', value: 'file', description: 'run this .ps1/.mjs/.cmd inside the sandbox first (repeatable)', advanced: true },
  bool('--window', 'show the sandbox window even if config says headless', { advanced: true }),
  bool('--trust-config', 'approve the folder\'s .sandbox-config.json without asking', { advanced: true }),
  bool('--no-local-config', 'ignore the folder\'s .sandbox-config.json', { advanced: true }),
];
const AGENT_OPTIONS: OptionSpecT[] = [
  text('--harness', 'name', 'agent to run', { choices: 'harnesses' }),
  text('--account', 'name', 'Claude account for this sandbox', { choices: 'accounts' }),
  ...SANDBOX_OPTIONS,
  bool('--no-agent', 'provision the sandbox without starting an agent', { advanced: true }),
];
const json = true;

export const COMMANDS: CommandSpecT[] = z.array(CommandSpec).parse([
  { name: 'launch', summary: 'start the sandbox and an agent (or another session in the running sandbox)', group: 'Agents', args: [], options: AGENT_OPTIONS, passthrough: 'agent', interactive: true },
  { name: 'start', summary: 'start the sandbox WITHOUT an agent: just the machine, toolchains and databases', group: 'Sandbox', args: [], options: SANDBOX_OPTIONS.filter((o) => o.flag !== '--new'), interactive: true },
  { name: 'generate', summary: 'dry run: write the .wsb and launch folder and show what would happen, start nothing', group: 'Health', args: [], options: AGENT_OPTIONS, passthrough: 'agent' },
  { name: 'attach', summary: 'show a running session in this terminal (Ctrl+] detaches)', group: 'Sessions', args: [{ name: 'id', description: 'session (default: the newest)', required: false, choices: 'sessions' }], options: [], interactive: true },
  { name: 'sessions', summary: 'list agent sessions and who is attached', group: 'Sessions', args: [], options: [], json },
  { name: 'status', summary: 'sandbox overview', group: 'Sandbox', args: [], options: [], json },
  { name: 'exec', summary: 'run a command inside the sandbox and print its output', group: 'Sandbox', args: [{ name: 'command', description: 'command and its arguments', required: true, variadic: true }], options: [{ flag: '--timeout', type: 'number', value: 'seconds', description: 'give up after this many seconds', default: 600 }, text('--workspace', 'dir', 'folder (inside the mapped workspace) to run in')], passthrough: 'command', json },
  { name: 'restart', summary: 'restart running agents in place; they resume their conversation', group: 'Sessions', args: [], options: [text('--harness', 'name', 'only this agent', { choices: 'harnesses' })] },
  { name: 'stop', summary: 'shut the sandbox down', group: 'Sandbox', args: [], options: [] },
  { name: 'show', summary: 'show the sandbox window', group: 'Sandbox', args: [], options: [] },
  { name: 'hide', summary: 'hide the sandbox window (it keeps running)', group: 'Sandbox', args: [], options: [] },
  { name: 'account', summary: 'Claude accounts: list, save, use, set the default, remove', group: 'Accounts', args: [{ name: 'action', description: 'what to do', required: false, choices: ['list', 'save', 'use', 'default', 'remove'] }, { name: 'name', description: 'account name', required: false, choices: 'accounts' }], options: [bool('--from-host', '(save) save this PC\'s login instead of the sandbox\'s'), bool('--no-restart', '(use) do not restart running sessions')], json },
  { name: 'data', summary: 'what persists between sandboxes (tools, databases, logins, logs), and cleaning it', group: 'Data', args: [{ name: 'action', description: 'show or clean', required: false, choices: ['show', 'clean'] }, { name: 'targets', description: 'what to clean, e.g. tools/go databases logs', required: false, variadic: true }], options: [bool('--yes', 'do not ask before deleting')], json },
  { name: 'clean', summary: 'delete old launch folders, logs and leftovers', group: 'Data', args: [], options: [{ flag: '--days', type: 'number', value: 'n', description: 'launch folders older than this many days', default: 7 }] },
  { name: 'sync', summary: 'copy history (and claude-mem, once closed) back to this PC now', group: 'Data', args: [], options: [] },
  { name: 'logs', summary: 'print the newest sandbox log', group: 'Health', args: [], options: [bool('--follow', 'keep printing new lines', { short: '-f' })] },
  { name: 'setup', summary: 'check this PC can run Windows Sandbox and offer to turn it on', group: 'Health', args: [], options: [] },
  { name: 'doctor', summary: 'check this PC and show what will be copied or downloaded', group: 'Health', args: [], options: [text('--harness', 'name', 'agent to check', { choices: 'harnesses' })] },
  { name: 'repair', summary: 'find and fix common problems (stale state, broken downloads, half-installed tools)', group: 'Health', args: [], options: [] },
  { name: 'self-test', summary: 'run the built-in tests', group: 'Health', args: [], options: [] },
  { name: 'config', summary: 'show the effective config, its path, create it, editor schemas, or check a project\'s .sandbox-config.json', group: 'Config', args: [{ name: 'action', description: 'what to do', required: false, choices: ['show', 'path', 'init', 'schema', 'check'] }], options: [text('--workspace', 'dir', '(check) the project folder; default: the current one')] },
  { name: 'host-claude', summary: 'Claude on this PC (NOT sandboxed) with a separate profile', group: 'Agents', args: [], options: [bool('--personal', 'use your normal Claude profile')], passthrough: 'agent', interactive: true },
  { name: 'menu', summary: 'the interactive menu (what `sandbox` opens with no arguments)', group: 'Config', args: [], options: [], hidden: true, interactive: true },
  { name: '_watch', summary: 'background history sync', group: 'Data', args: [], options: [], hidden: true },
]);

export const commandSpec = (name: string): CommandSpecT | undefined => COMMANDS.find((c) => c.name === name);
