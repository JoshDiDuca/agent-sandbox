// Runs the migrations that have not run yet, in list order. Each one is backed up first and recorded only when it
// succeeds; a failure puts its backup back and stops the run, so the next start tries again from the same place.
import { errMsg, fail } from '../../core/util/index.js';
import { MigrationBackup } from './backup.js';
import { MigrationMarker } from './marker.js';
import type { Migration, MigrationContext } from './migration.js';

export interface MigrationReport {
  readonly applied: string[];
  readonly postponed: string[];
}

export class MigrationRunner {
  constructor(
    private readonly migrations: readonly Migration[],
    private readonly ctx: MigrationContext,
    private readonly marker: MigrationMarker = new MigrationMarker(ctx.userDir),
  ) {}

  /** Not recorded as applied, and still needed (applies() is checked now). */
  pending(): Migration[] {
    const done = new Set(this.marker.read().applied.map((entry) => entry.id));
    return this.migrations.filter((migration) => !done.has(migration.id) && migration.applies(this.ctx));
  }

  async run(version: string, note: (line: string) => void): Promise<MigrationReport> {
    const applied: string[] = [];
    const postponed: string[] = [];
    for (const migration of this.pending()) {
      if (migration.needsIdleSandbox && this.ctx.sandboxRunning()) {
        note('Postponed ' + migration.id + ' until no sandbox runs.');
        postponed.push(migration.id);
        continue;
      }
      const touched = migration.touches(this.ctx);
      const backup = touched.length ? this.backup(touched, version) : null;
      try {
        await migration.run(this.ctx, note);
      } catch (e) {
        fail(
          'Updating your saved settings failed (' + migration.id + '): ' + errMsg(e),
          this.recover(backup) + ' Run sandbox migrate to try again, or report it.',
        );
      }
      this.marker.record(migration.id, backup?.path ?? null);
      applied.push(migration.id);
    }
    this.marker.setVersion(version);
    return { applied, postponed };
  }

  /** Puts a backup made by an earlier run back (only folders under the storage root's backups). */
  restore(backupPath: string): void {
    MigrationBackup.open(this.ctx.storageRoot, backupPath).restore();
  }

  /** One line per pending migration, for a dry run. */
  planText(): string[] {
    return this.pending().map((migration) => migration.id + ': ' + migration.summary);
  }

  private backup(touched: readonly string[], version: string): MigrationBackup {
    const backup = MigrationBackup.create(this.ctx.storageRoot, this.marker.read().lastVersion, version);
    backup.save(touched);
    return backup;
  }

  private recover(backup: MigrationBackup | null): string {
    if (!backup) return 'Nothing was changed.';
    try {
      backup.restore();
      return 'Your files are back as they were (backup: ' + backup.path + ').';
    } catch (e) {
      return 'Putting your files back failed too (' + errMsg(e) + '); copy them back from ' + backup.path + ' by hand.';
    }
  }
}
