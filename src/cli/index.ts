import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import { parseCli } from './args.js';
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
  'host-claude': commands.claudeHost,
  _watch: commands.watcher,
};

const red = (s: string): string => '\x1b[31m' + s + '\x1b[0m';
const dim = (s: string): string => '\x1b[2m' + s + '\x1b[0m';

/** CLI entry. `preset` lets wrapper binaries fix the command/agent (claude-sbx = launch --harness claude). */
export const main = async (argv: string[], preset: { harness?: string; command?: string } = {}): Promise<number> => {
  const options = parseCli(preset.command ? [preset.command, ...argv] : argv, Boolean(preset.harness));
  if (preset.harness) options.harness = preset.harness;
  // Loaded only when asked for: normal commands never load test code.
  if (options.command === 'self-test') return (await import('../selftest/index.js')).selfTest(packageRoot);
  const handler = HANDLERS[options.command];
  if (!handler) return fail('Unknown command "' + options.command + '".', 'Run agent-sandbox --help for the list of commands.');
  return (await handler(commands.createContext(packageRoot, entry, options))) ?? 0;
};

/** Prints a problem the way a user can act on it: what happened, how to fix it; stack traces only for real bugs. */
export const report = (e: unknown): number => {
  if (e instanceof CommanderError) return ['commander.helpDisplayed', 'commander.help', 'commander.version'].includes(e.code) ? 0 : e.exitCode || 1;
  if (e instanceof UserError) {
    console.error(red('Error: ') + e.message);
    if (e.fix) console.error('  Fix:  ' + e.fix);
    return 1;
  }
  console.error(red('Unexpected error: ') + errMsg(e));
  console.error(dim('This is a bug in agent-sandbox. Details: ' + (e instanceof Error && e.stack ? e.stack.split('\n').slice(1, 4).join(' | ').trim() : 'none')));
  console.error('  Please report it with the output of: agent-sandbox doctor');
  return 1;
};

export const run = (argv: string[], preset?: { harness?: string; command?: string }): void => {
  main(argv, preset).then((code) => { process.exitCode = code; }, (e: unknown) => { process.exitCode = report(e); });
};
