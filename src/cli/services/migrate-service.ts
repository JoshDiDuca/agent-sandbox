// Bringing the saved settings up to date with this version: the logic behind `sandbox migrate`, the automatic run at
// the start of a command and the Maintenance row. Returns data, never prints.
import { MIGRATIONS, MigrationMarker, MigrationRunner, type Migration } from '../../host/migrate/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import { packageVersion } from '../../core/package-info.js';

/** Where the saved settings are: the storage root, the config folder and the config file (if any). */
export interface MigrateContext {
  readonly storageRoot: string;
  readonly userDir: string;
  readonly configPath: string | null;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly postponed: readonly string[];
}

export class MigrateService {
  private readonly marker: MigrationMarker;
  private readonly runner: MigrationRunner;

  constructor(
    where: MigrateContext,
    private readonly version: string = packageVersion(),
    migrations: readonly Migration[] = MIGRATIONS,
    sandboxRunning: () => boolean = isSandboxRunning,
  ) {
    this.marker = new MigrationMarker(where.userDir);
    this.runner = new MigrationRunner(migrations, { ...where, sandboxRunning }, this.marker);
  }

  /** The version that last brought the settings up to date (one small file). */
  lastVersion(): string {
    return this.marker.read().lastVersion;
  }

  /** The settings were last updated by another version than this one. */
  versionChanged(): boolean {
    return this.lastVersion() !== this.version;
  }

  /** One line per change still to make. */
  plan(): string[] {
    return this.runner.planText();
  }

  async run(note: (line: string) => void): Promise<MigrateResult> {
    return this.runner.run(this.version, note);
  }

  restore(backup: string): void {
    this.runner.restore(backup);
  }
}

/** Commands that never update the settings first: they must work whatever state the settings are in. */
const NO_AUTO_MIGRATION: readonly string[] = ['self-test', 'migrate', '_watch'];

/** Does this command update the saved settings before it runs (when the version changed)? Never inside a sandbox. */
export function autoMigrates(command: string, inSandbox: boolean): boolean {
  return !inSandbox && !NO_AUTO_MIGRATION.includes(command);
}

/** On failure the command still runs only for these: they are how you find out what is wrong. */
export function continuesAfterFailedMigration(command: string): boolean {
  return command === 'doctor' || command === 'migrate';
}
