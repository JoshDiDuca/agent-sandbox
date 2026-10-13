import path from 'node:path';
import { buildProgram, parseCli } from './args.js';
import { commandSpec } from './manifest.js';
import { recordHistory } from './history.js';
import { menu } from './menu/index.js';
import { validateOptions } from './validate.js';
import { loadConfig } from '../core/config/index.js';
import * as commands from './commands/index.js';
import { fail } from '../core/util/index.js';
import { PACKAGE_ROOT } from '../core/package-info.js';
import { withConfig, hoistConfig, withoutConfig } from './argv.js';
import { report } from './report.js';
import { HANDLERS } from './commands/index.js';

const entry = path.join(PACKAGE_ROOT, 'dist', 'bin', 'agent-sandbox.js');

export interface Preset {
  harness?: string;
  command?: string;
}

/** Runs an argv from the menu exactly as if it had been typed, reporting errors instead of throwing. */
const runFromMenu =
  (config: string | undefined) =>
  (argv: string[]): Promise<number> =>
    main(withConfig(argv, config)).catch((e: unknown) => report(e));

/**
 * CLI entry. `preset` lets wrapper binaries fix the command/agent (sandbox claude = launch --harness claude). No
 * arguments opens the menu; `sandbox <agent> [agent args]` starts that agent.
 */
export async function main(rawArgv: string[], preset: Preset = {}): Promise<number> {
  const argv = preset.command || preset.harness ? rawArgv : hoistConfig(rawArgv);
  const isAgent = (name: string | undefined): name is string => {
    if (!name || name.startsWith('-') || commandSpec(name)) return false;
    const at = argv.indexOf('--config');
    try {
      return Boolean(loadConfig(at >= 0 ? argv[at + 1] : undefined).config.harnesses[name]);
    } catch {
      return false;
    }
  };
  if (!preset.command && !preset.harness) {
    if (argv.length === 0)
      return process.stdin.isTTY ? main(['menu']) : (buildProgram(() => undefined).outputHelp(), 0);
    if (isAgent(argv[0])) return main(argv.slice(1), { harness: argv[0] });
  }
  const options = parseCli(preset.command ? [preset.command, ...argv] : argv, Boolean(preset.harness));
  if (preset.harness) options.harness = preset.harness;
  const typed = preset.harness
    ? ['launch', '--harness', preset.harness, ...argv]
    : preset.command
      ? [preset.command, ...argv]
      : argv;
  if (options.command === 'menu')
    return menu(commands.createContext(PACKAGE_ROOT, entry, options), runFromMenu(options.config));
  // Loaded only when asked for: normal commands never load test code.
  if (options.command === 'self-test')
    return (await import('../selftest/index.js')).selfTest(PACKAGE_ROOT, options.positionals);
  // repair must run even when the config file is broken (createContext would refuse it).
  if (options.command === 'repair') {
    recordHistory(withoutConfig(typed));
    return commands.repairCommand(PACKAGE_ROOT, entry, options);
  }
  const handler = HANDLERS[options.command];
  if (!handler)
    return fail(
      'Unknown command "' + options.command + '".',
      'Run sandbox --help for the list of commands, or sandbox for the menu.',
    );
  const ctx = commands.createContext(PACKAGE_ROOT, entry, options);
  validateOptions(ctx);
  // Only what parsed and validated is offered again by the menu, without the --config (it is the same every time).
  recordHistory(withoutConfig(typed));
  return (await handler(ctx)) ?? 0;
}

export function run(argv: string[], preset?: Preset): void {
  main(argv, preset).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.exitCode = report(e);
    },
  );
}
