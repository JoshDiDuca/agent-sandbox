// Changes made in the menu but not saved yet: Settings and Apps stage here, Ctrl+S writes them (one write per file,
// comments kept) and leaving asks what to do with them.
import _ from 'lodash';
import type { ConfigFile, SettingChange } from '../../../app/features/settings/index.js';

/** What saving did: how many settings were written and why a file was refused. */
export interface DraftResult {
  readonly saved: number;
  readonly problems: string[];
  /** The files that were written. */
  readonly files: ConfigFile[];
}

export class Draft {
  private readonly staged = new Map<ConfigFile, Map<string, SettingChange>>();

  /** Stages a change; staging what the file already says drops the staged change instead. */
  stage(file: ConfigFile, key: string[], value: unknown): void {
    const id = key.join('.');
    const changes = this.staged.get(file) ?? new Map<string, SettingChange>();
    if (_.isEqual(value, file.valueInFile(key))) changes.delete(id);
    else changes.set(id, { key, value });
    if (changes.size) this.staged.set(file, changes);
    else this.staged.delete(file);
  }

  /** Is there a staged change for this setting (including "back to default")? */
  has(file: ConfigFile, key: string[]): boolean {
    return Boolean(this.staged.get(file)?.has(key.join('.')));
  }

  /** What the file will say once saved: the staged value, else what is in the file now. */
  value(file: ConfigFile, key: string[]): unknown {
    const change = this.staged.get(file)?.get(key.join('.'));
    return change ? change.value : file.valueInFile(key);
  }

  /** Drops the staged change of one setting. */
  unstage(file: ConfigFile, key: string[]): void {
    const changes = this.staged.get(file);
    changes?.delete(key.join('.'));
    if (changes && !changes.size) this.staged.delete(file);
  }

  /** Number of settings with unsaved changes, in all files (or one file). */
  count(file?: ConfigFile): number {
    if (file) return this.staged.get(file)?.size ?? 0;
    return _.sumBy([...this.staged.values()], (changes) => changes.size);
  }

  /** The staged changes of one file. */
  changes(file: ConfigFile): SettingChange[] {
    return [...(this.staged.get(file)?.values() ?? [])];
  }

  discard(): void {
    this.staged.clear();
  }

  /** Writes every file once. A file that is refused keeps its staged changes; the others are saved. */
  apply(): DraftResult {
    const problems: string[] = [];
    const files: ConfigFile[] = [];
    let saved = 0;
    for (const [file, changes] of [...this.staged]) {
      const result = file.setMany([...changes.values()]);
      if (typeof result === 'object') {
        problems.push(...result.problems);
        continue;
      }
      if (result === 'saved') {
        saved += changes.size;
        files.push(file);
      }
      this.staged.delete(file);
    }
    return { saved, problems, files };
  }
}
