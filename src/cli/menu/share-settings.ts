// The "Export settings…" and "Import settings…" rows in Settings > General: pick a file, then (for an import) read the
// diff of what would change and say yes once. Same rules as sandbox config export / import.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../core/config/index.js';
import { errMsg } from '../../core/util/index.js';
import { applyImport, DEFAULT_EXPORT, readImport, writeExport } from '../commands/maintenance/config-share.js';
import type { Context } from '../commands/context.js';
import { Theme, type App } from '../tui/index.js';
import { askPath } from './settings/ask-path.js';
import { diffText, skippedLine } from './settings/index.js';

/** The rows' ids in the settings list. */
export const EXPORT_SETTINGS = '@export-settings';
export const IMPORT_SETTINGS = '@import-settings';

export function shareSettingsRows(): { value: string; label: string; hint: string; description: string }[] {
  return [
    {
      value: EXPORT_SETTINGS,
      label: 'Export settings…',
      hint: '.json',
      description:
        'Write the settings you changed to a .json file you can share with a team. Secrets, the data folder and folders or files of this PC are left out.',
    },
    {
      value: IMPORT_SETTINGS,
      label: 'Import settings…',
      hint: '.json',
      description:
        'Read a settings file someone shared, see what it would change, and apply it once you say yes. Secrets, the data folder and paths in it are never taken.',
    },
  ];
}

export class ShareSettingsFlow {
  constructor(
    private readonly app: App,
    private readonly ctx: Context,
  ) {}

  /** Your settings as they are on disk now (the menu may have saved changes since it started). */
  private fresh(): Context {
    return { ...this.ctx, loaded: loadConfig(this.ctx.loaded.configPath ?? undefined) };
  }

  /** Returns the notice to show (undefined when cancelled). */
  async export(): Promise<string | undefined> {
    const where = ['Settings', 'Export settings'];
    try {
      const file = await askPath(this.app, {
        path: where,
        title: 'Where to write the settings file',
        about: ['Only what differs from the defaults is written; secrets and paths of this PC are left out.'],
        initial: path.resolve(DEFAULT_EXPORT),
        kind: 'file',
        validate: (p) => (p.toLowerCase().endsWith('.json') ? true : 'The file name should end in .json.'),
      });
      if (!file) return undefined;
      const exists = path.resolve(file);
      const replace = fs.existsSync(exists);
      if (
        replace &&
        !(await this.app.confirm({ path: where, question: exists + ' exists. Replace it?', initial: false }))
      )
        return undefined;
      const skipped = writeExport(this.fresh(), file, false, replace);
      return (
        Theme.ok(Theme.glyph.ok + ' Wrote ' + exists + '.') +
        (skipped.length ? Theme.muted(' Left out: ' + skipped.join(', ') + '.') : '')
      );
    } catch (e) {
      return Theme.error(Theme.glyph.cross + ' ' + errMsg(e));
    }
  }

  async import(): Promise<string | undefined> {
    const where = ['Settings', 'Import settings'];
    try {
      const file = await askPath(this.app, {
        path: where,
        title: 'Which settings file',
        about: ['A file made by Export settings (or sandbox config export).'],
        kind: 'file',
      });
      if (!file) return undefined;
      const ctx = this.fresh();
      const plan = readImport(ctx, file);
      const lines = [
        ...(plan.changes.length
          ? [
              plan.changes.length + ' setting' + (plan.changes.length === 1 ? '' : 's') + ' would change:',
              '',
              ...diffText(plan.lines),
            ]
          : ['Nothing to change: your settings already match the file.']),
        ...(plan.skipped.length
          ? ['', 'Not imported (never taken from a file):', ...plan.skipped.map((s) => skippedLine(s))]
          : []),
      ];
      if (!plan.changes.length) {
        await this.app.message({ path: where, lines });
        return Theme.muted('Nothing changed.');
      }
      const yes = await this.app.confirm({
        path: where,
        question: 'Change your settings like this?',
        about: lines,
        initial: false,
      });
      if (!yes) return Theme.muted('Nothing changed.');
      const n = applyImport(ctx, plan);
      return Theme.ok(Theme.glyph.ok + ' Imported ' + n + ' setting' + (n === 1 ? '' : 's') + '.');
    } catch (e) {
      return Theme.error(Theme.glyph.cross + ' ' + errMsg(e));
    }
  }
}
