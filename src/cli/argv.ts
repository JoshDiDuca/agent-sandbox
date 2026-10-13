/** `--config <file>` right after the command name (where every command accepts it); argv unchanged without a config. */
export const withConfig = (argv: string[], config: string | undefined): string[] =>
  config && argv.length ? [argv[0], '--config', config, ...argv.slice(1)] : argv;

/** `sandbox --config f.json status` works like `sandbox status --config f.json`: a leading --config moves behind the command. */
export const hoistConfig = (argv: string[]): string[] => {
  const eq = argv[0]?.startsWith('--config=');
  if (argv[0] !== '--config' && !eq) return argv;
  const value = eq ? argv[0].slice('--config='.length) : argv[1];
  const rest = argv.slice(eq ? 1 : 2);
  if (value === undefined || value === '') return argv;
  return rest.length ? withConfig(rest, value) : ['menu', '--config', value];
};

/** argv without `--config <file>` / `--config=<file>`. */
export const withoutConfig = (argv: string[]): string[] =>
  argv.filter((a, i) => a !== '--config' && argv[i - 1] !== '--config' && !a.startsWith('--config='));
