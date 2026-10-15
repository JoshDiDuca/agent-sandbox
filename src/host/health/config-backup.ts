// The copies of config.json that an update saved before it changed anything (<storage>\backups\migrate-*\), so a
// settings file that no longer loads can be put back. Read only; the caller shows the difference first and keeps the
// broken file.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertNoLinks, dirExists } from '../../core/util/index.js';
import { readValid } from '../../shared/io/index.js';

const ManifestSchema = z.object({
  entries: z.array(z.object({ original: z.string(), copy: z.string(), existed: z.boolean() })),
});
const MAX_CONFIG_BYTES = 1024 * 1024;

export interface ConfigBackup {
  readonly folder: string;
  /** The saved copy of the settings file. */
  readonly copy: string;
  /** From the folder name: "1.4.0 to 1.5.0 at 2026-10-14 09:30:12". */
  readonly label: string;
}

/** The stamp in migrate-<from>-<to>-<yyyymmddhhmmss>[-n] folder names. */
function stampOf(name: string): string {
  return /-(\d{14})(?:-\d+)?$/.exec(name)?.[1] ?? '';
}

function labelOf(name: string): string {
  const m = /^migrate-(.+?)-(.+?)-(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:-\d+)?$/.exec(name);
  return m
    ? m[1] + ' to ' + m[2] + ' at ' + m[3] + '-' + m[4] + '-' + m[5] + ' ' + m[6] + ':' + m[7] + ':' + m[8]
    : name;
}

/** Saved copies of `configFile`, newest first. A backup with no readable manifest or no such copy is skipped. */
export function configBackups(storageRoot: string, configFile: string): ConfigBackup[] {
  const dir = path.join(storageRoot, 'backups');
  if (!dirExists(dir)) return [];
  assertNoLinks(storageRoot, dir);
  const found: ConfigBackup[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('migrate-')) continue;
    const folder = path.join(dir, name);
    const manifest = readValid(ManifestSchema, path.join(folder, 'manifest.json'));
    const entry = manifest?.entries.find(
      (e) => e.existed && path.resolve(e.original).toLowerCase() === path.resolve(configFile).toLowerCase(),
    );
    if (!entry) continue;
    // The manifest is data on disk: the copy must be a file inside this backup folder, and small.
    const copy = path.resolve(entry.copy);
    if (!copy.toLowerCase().startsWith(path.resolve(folder).toLowerCase() + path.sep)) continue;
    try {
      assertNoLinks(storageRoot, copy);
      const stat = fs.statSync(copy);
      if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) continue;
    } catch {
      continue;
    }
    found.push({ folder, copy, label: labelOf(name) });
  }
  return found.sort((a, b) => stampOf(path.basename(b.folder)).localeCompare(stampOf(path.basename(a.folder))));
}

/** A short line difference: "- line" only in `current`, "+ line" only in `backup`; at most `max` lines. */
export function lineDiff(current: string, backup: string, max = 12): string[] {
  const split = (t: string): string[] =>
    t
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== '');
  const a = split(current);
  const b = split(backup);
  const inB = new Set(b);
  const inA = new Set(a);
  const lines = [
    ...a.filter((l) => !inB.has(l)).map((l) => '- ' + l.trim()),
    ...b.filter((l) => !inA.has(l)).map((l) => '+ ' + l.trim()),
  ];
  return lines.length > max
    ? [...lines.slice(0, max), '... and ' + (lines.length - max) + ' more changed lines']
    : lines;
}
