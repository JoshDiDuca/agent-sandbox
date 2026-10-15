// `sandbox --version`: the version and where it runs from; `--version --short` is the plain number (the updater and the
// installer compare it to the version they just installed).
import { packageVersion } from '../core/package-info.js';
import { describeCopy } from '../host/install/index.js';

/** The text for a version-only command line (`--version`, `-v`, with or without `--short`), or null for any other. */
export function versionText(argv: readonly string[], packageRoot: string): string | null {
  const flags = argv.filter((a) => a !== '--short');
  if (flags.length === 0 || flags.some((a) => a !== '--version' && a !== '-v')) return null;
  return argv.includes('--short') ? packageVersion() : packageVersion() + ' (' + describeCopy(packageRoot) + ')';
}
