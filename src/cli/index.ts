import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import { buildProgram, parseCli } from './args.js';
import { commandSpec } from './manifest.js';
import { c } from './colors.js';
import { recordHistory } from './history.js';
import { menu } from './menu.js';
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
  db: commands.db,
  restart: commands.restart,
  stop: commands.stop,
  show: commands.show,
  hide: commands.hide,
  account: commands.account,
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
const runFromMenu = (argv: string[]): Promise<number> => main(argv).catch((e: unknown) => report(e));

/**
 * CLI entry. `preset` lets wrapper binaries fix the command/agent (sandbox claude = launch --harness claude). No arguments
 * opens the menu; `sandbox <agent> [agent args]` starts that agent.
 */
export const main = async (argv: string[], preset: Preset = {}): Promise<number> => {
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
  recordHistory(preset.harness ? ['launch', '--harness', preset.harness, ...argv] : preset.command ? [preset.command, ...argv] : argv);
  if (options.command === 'menu') return menu(commands.createContext(packageRoot, entry, options), runFromMenu);
  // Loaded only when asked for: normal commands never load test code.
  if (options.command === 'self-test') return (await import('../selftest/index.js')).selfTest(packageRoot);
  // repair must run even when the config file is broken (createContext would refuse it).
  if (options.command === 'repair') return commands.repairCommand(packageRoot, entry, options);
  const handler = HANDLERS[options.command];
  if (!handler) return fail('Unknown command "' + options.command + '".', 'Run sandbox --help for the list of commands, or sandbox for the menu.');
  return (await handler(commands.createContext(packageRoot, entry, options))) ?? 0;
};

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
