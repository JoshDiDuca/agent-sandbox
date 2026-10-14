// Copies of what a migration is about to change, in <storageRoot>\backups\migrate-<from>-<to>-<stamp>\, so a failed run
// can put every file and folder back byte for byte. Data sets are never copied (they can be gigabytes and the
// migrations do not change them), and links are refused (the sandbox can plant them).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertNoLinks, fail, isInsideOrEqual, isLink } from '../../core/util/index.js';
import { JsonFile } from '../../shared/io/index.js';

const ManifestSchema = z.object({
  entries: z.array(z.object({ original: z.string(), copy: z.string(), existed: z.boolean() })),
});
type Manifest = z.infer<typeof ManifestSchema>;

const stamp = (): string => {
  const d = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    two(d.getMonth() + 1) +
    two(d.getDate()) +
    two(d.getHours()) +
    two(d.getMinutes()) +
    two(d.getSeconds())
  );
};

/** True if the folder holds a link anywhere inside it (the copy would follow or recreate it). */
function containsLink(dir: string): boolean {
  return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink() || isLink(full)) return true;
    return entry.isDirectory() && containsLink(full);
  });
}

export class MigrationBackup {
  private readonly manifest: JsonFile<Manifest>;

  private constructor(
    private readonly storageRoot: string,
    private readonly folder: string,
  ) {
    this.manifest = new JsonFile(ManifestSchema, path.join(folder, 'manifest.json'));
  }

  /** A new, empty backup folder for a run from one version to another (never an existing one). */
  static create(storageRoot: string, from: string, to: string): MigrationBackup {
    const base = path.join(storageRoot, 'backups', 'migrate-' + from + '-' + to + '-' + stamp());
    let folder = base;
    for (let n = 2; fs.existsSync(folder); n++) folder = base + '-' + n;
    return new MigrationBackup(storageRoot, folder);
  }

  /** An existing backup folder (for restoring it). Only folders under the storage root's backups are accepted. */
  static open(storageRoot: string, folder: string): MigrationBackup {
    if (!isInsideOrEqual(path.join(storageRoot, 'backups'), folder))
      fail('Refusing to restore ' + folder + ': it is not a backup folder under ' + storageRoot + '.');
    return new MigrationBackup(storageRoot, folder);
  }

  get path(): string {
    return this.folder;
  }

  /** Copies each existing file or folder (and records the ones that do not exist yet, to remove them on restore). */
  save(paths: readonly string[]): void {
    const dataRoot = path.join(this.storageRoot, 'data');
    const entries: Manifest['entries'] = this.manifest.read()?.entries ?? [];
    for (const target of paths) {
      if (isInsideOrEqual(dataRoot, target))
        fail(
          'Refusing to back up ' + target + ': data sets are never copied.',
          'A migration must not change a data set.',
        );
      assertNoLinks(path.dirname(target), target);
      const existed = fs.existsSync(target);
      const copy = path.join(this.folder, 'files', entries.length + '-' + path.basename(target));
      if (existed) {
        if (fs.statSync(target).isDirectory() && containsLink(target))
          fail('Refusing to back up ' + target + ': it holds a link (possible escape attempt from the sandbox).');
        fs.mkdirSync(path.dirname(copy), { recursive: true });
        fs.cpSync(target, copy, { recursive: true, verbatimSymlinks: true });
      }
      entries.push({ original: target, copy, existed });
    }
    this.manifest.write({ entries });
  }

  /** Puts every saved path back: copies restored, paths that did not exist before removed again. Last saved first. */
  restore(): void {
    const saved = this.manifest.read();
    if (!saved)
      fail('The backup ' + this.folder + ' has no readable manifest.', 'Restore its files by hand, or report it.');
    for (const entry of [...saved.entries].reverse()) {
      fs.rmSync(entry.original, { recursive: true, force: true });
      if (!entry.existed) continue;
      if (!fs.existsSync(entry.copy))
        fail('The backup is missing ' + entry.copy + '.', 'Report this: the backup is damaged.');
      fs.mkdirSync(path.dirname(entry.original), { recursive: true });
      fs.cpSync(entry.copy, entry.original, { recursive: true, verbatimSymlinks: true });
    }
  }
}
