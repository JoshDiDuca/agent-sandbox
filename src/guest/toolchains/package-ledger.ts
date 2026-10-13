// Global packages (npm, gems, go tools, uv tools, cargo crates) installed once: remembered in
// tools\installed-packages.json under "<group>:<package>" with the time it was installed.
import { z } from 'zod';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { log, warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';
import { tool, type ToolEnv } from './tool-env.js';
import { readState } from './state-file.js';

const LedgerSchema = z.record(z.string(), z.string());

export class PackageLedger {
  constructor(private readonly file: () => string = () => tool('installed-packages.json')) {}

  has(group: string, pkg: string): boolean {
    return Boolean(this.read()[group + ':' + pkg]);
  }

  /** Records `pkg` as installed now (re-read first: parallel steps write the same file). */
  mark(group: string, pkg: string): void {
    writeJsonAtomic(this.file(), { ...this.read(), [group + ':' + pkg]: new Date().toISOString() });
  }

  /**
   * Installs each package that is not installed yet (group e.g. "npm@22.11.0"). One failing package is reported and
   * skipped; it is tried again next boot.
   */
  async installOnce(
    env: ToolEnv,
    group: string,
    packages: readonly string[],
    install: (pkg: string) => void | Promise<void>,
  ): Promise<void> {
    const todo = packages.filter((p) => !this.has(group, p));
    for (const pkg of todo) {
      try {
        log('Installing ' + pkg + ' (' + group + ') ...');
        await install(pkg);
        this.mark(group, pkg);
      } catch (e) {
        warn(
          pkg +
            ' (' +
            group +
            ') could not be installed and is skipped; the next start tries again. Reason: ' +
            errMsg(e),
        );
      }
    }
    const ok = packages.filter((p) => this.has(group, p));
    if (ok.length) env.summary.push(group.split('@')[0] + ' packages: ' + ok.join(', '));
  }

  private read(): Record<string, string> {
    return readState(this.file(), LedgerSchema, {});
  }
}

export const packageLedger = new PackageLedger();

/** packageLedger.installOnce: installs the packages of `group` that are not installed yet. */
export function installOnce(
  env: ToolEnv,
  group: string,
  packages: readonly string[],
  install: (pkg: string) => void | Promise<void>,
): Promise<void> {
  return packageLedger.installOnce(env, group, packages, install);
}
