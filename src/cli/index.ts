import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import { buildProgram, parseCli } from './args.js';
import { commandSpec } from './manifest.js';
import { c } from './colors.js';
import { recordHistory } from './history.js';
import { menu } from './menu/index.js';
import { validateOptions } from './validate.js';
import { loadConfig } from '../core/config.js';
import * as commands from './commands/index.js';
import { UserError, errMsg, fail } from '../core/util.js';

/** The package folder (this file is dist/cli/index.js). */
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = path.join(packageRoot, 'dist', 'bin', 'agent-sandbox.js');

type Handler = (ctx: commands.Context) => number | Promise<number | void>;

const HANDLERS: Record<string, Handler> = {
  launch: (ctx) => commands.launch(ctx),
  generate: (ctx) => commands.launch(ctx, true),
  attach: commands.attach,
  sessions: commands.sessions,
  status: commands.status,
  exec: commands.exec,
  'agent-commands': commands.agentCommandsCommand,
  db: commands.db,
  restart: commands.restart,
  stop: commands.stop,
  show: commands.show,
  hide: commands.hide,
  account: commands.account,
  projects: commands.projects,
  sync: commands.sync,
  logs: commands.logs,
  clean: commands.clean,
  config: commands.config,
  doctor: commands.doctor,
  setup: commands.setup,
  data: commands.data,
  'host-claude': commands.claudeHost,
  _watch: commands.watcher,
};


export interface Preset { harness?: string; command?: string }

/** Runs an argv from the menu exactly as if it had been typed, reporting errors instead of throwing. */
const runFromMenu = (config: string | undefined) => (argv: string[]): Promise<number> => main(withConfig(argv, config)).catch((e: unknown) => report(e));

/** `--config <file>` right after the command name (where every command accepts it); argv unchanged without a config. */
export const withConfig = (argv: string[], config: string | undefined): string[] => (config && argv.length ? [argv[0], '--config', config, ...argv.slice(1)] : argv);

/** `sandbox --config f.json status` works like `sandbox status --config f.json`: a leading --config moves behind the command. */
export const hoistConfig = (argv: string[]): string[] => {
  const eq = argv[0]?.startsWith('--config=');
  if (argv[0] !== '--config' && !eq) return argv;
  const value = eq ? argv[0].slice('--config='.length) : argv[1];
  const rest = argv.slice(eq ? 1 : 2);
  if (value === undefined || value === '') return argv;
  return rest.length ? withConfig(rest, value) : ['menu', '--config', value];
};

/**
 * CLI entry. `preset` lets wrapper binaries fix the command/agent (sandbox claude = launch --harness claude). No arguments
 * opens the menu; `sandbox <agent> [agent args]` starts that agent.
 */
export const main = async (rawArgv: string[], preset: Preset = {}): Promise<number> => {
  const argv = preset.command || preset.harness ? rawArgv : hoistConfig(rawArgv);
  const isAgent = (name: string | undefined): name is string => {
    if (!name || name.startsWith('-') || commandSpec(name)) return false;
    const at = argv.indexOf('--config');
    try { return Boolean(loadConfig(at >= 0 ? argv[at + 1] : undefined).config.harnesses[name]); } catch { return false; }
  };
  if (!preset.command && !preset.harness) {
    if (argv.length === 0) return process.stdin.isTTY ? main(['menu']) : (buildProgram(() => undefined).outputHelp(), 0);
    if (isAgent(argv[0])) return main(argv.slice(1), { harness: argv[0] });
  }
  const options = parseCli(preset.command ? [preset.command, ...argv] : argv, Boolean(preset.harness));
  if (preset.harness) options.harness = preset.harness;
  const typed = preset.harness ? ['launch', '--harness', preset.harness, ...argv] : preset.command ? [preset.command, ...argv] : argv;
  if (options.command === 'menu') return menu(commands.createContext(packageRoot, entry, options), runFromMenu(options.config));
  // Loaded only when asked for: normal commands never load test code.
  if (options.command === 'self-test') return (await import('../selftest/index.js')).selfTest(packageRoot, options.positionals);
  // repair must run even when the config file is broken (createContext would refuse it).
  if (options.command === 'repair') { recordHistory(withoutConfig(typed)); return commands.repairCommand(packageRoot, entry, options); }
  const handler = HANDLERS[options.command];
  if (!handler) return fail('Unknown command "' + options.command + '".', 'Run sandbox --help for the list of commands, or sandbox for the menu.');
  const ctx = commands.createContext(packageRoot, entry, options);
  validateOptions(ctx);
  // Only what parsed and validated is offered again by the menu, without the --config (it is the same every time).
  recordHistory(withoutConfig(typed));
  return (await handler(ctx)) ?? 0;
};

/** argv without `--config <file>` / `--config=<file>`. */
export const withoutConfig = (argv: string[]): string[] => argv.filter((a, i) => a !== '--config' && argv[i - 1] !== '--config' && !a.startsWith('--config='));

/** Prints a problem the way a user can act on it: what happened, how to fix it; stack traces only for real bugs. */
export const report = (e: unknown): number => {
  if (e instanceof CommanderError) return ['commander.helpDisplayed', 'commander.help', 'commander.version'].includes(e.code) ? 0 : e.exitCode || 1;
  if (e instanceof UserError) {
    console.error(c.red('Error: ') + e.message);
    if (e.fix) console.error('  Fix:  ' + e.fix);
    return 1;
  }
  console.error(c.red('Unexpected error: ') + errMsg(e));
  console.error(c.dim('This is a bug in windows-development-sandbox. Details: ' + (e instanceof Error && e.stack ? e.stack.split('\n').slice(1, 4).join(' | ').trim() : 'none')));
  console.error('  Please report it with the output of: sandbox doctor');
  return 1;
};

export const run = (argv: string[], preset?: Preset): void => {
  main(argv, preset).then((code) => { process.exitCode = code; }, (e: unknown) => { process.exitCode = report(e); });
};
