// Which files of a project git ignores, read the way git reads them: the .gitignore in every folder (deeper files win,
// `!pattern` lets a file back in), .git/info/exclude, and nothing inside an ignored folder ever comes back. Plus your
// own extra patterns (workspaceFilter.exclude) and exceptions (workspaceFilter.include). Bounded reads: a .gitignore
// over 256 KB is treated as empty.
import fs from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

const MAX_RULES_BYTES = 256 * 1024;

const readRules = (file: string): string => {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size <= MAX_RULES_BYTES ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
};

export class IgnoreRules {
  /** One matcher per folder that has a .gitignore (null = the folder has none), by its path relative to the root. */
  private readonly perFolder = new Map<string, Ignore | null>();
  private readonly extra: Ignore;
  private readonly forced: Ignore;

  /** `root`: the project folder on this PC (its .gitignore files are the rules); `exclude` / `include`: your patterns. */
  constructor(
    private readonly root: string,
    exclude: string[] = [],
    private readonly include: string[] = [],
  ) {
    this.extra = ignore().add(exclude);
    this.forced = ignore().add(include);
  }

  /** One of your include patterns lets this path in, whatever .gitignore says (even inside an ignored folder). */
  isForced(rel: string): boolean {
    return this.include.length > 0 && this.forced.ignores(rel);
  }

  /** Could one of your include patterns match something inside this ignored folder (so a walk must look inside)? */
  mayIncludeInside(dir: string): boolean {
    return this.include.some((p) => {
      const clean = p.replace(/^\//, '');
      return clean.startsWith('**') || clean.startsWith(dir + '/');
    });
  }

  /** Forget the .gitignore files read so far (one of them changed). */
  reset(): void {
    this.perFolder.clear();
  }

  private matcher(folder: string): Ignore | null {
    if (this.perFolder.has(folder)) return this.perFolder.get(folder)!;
    const dir = path.join(this.root, ...folder.split('/').filter(Boolean));
    let text = readRules(path.join(dir, '.gitignore'));
    if (folder === '') text += '\n' + readRules(path.join(this.root, '.git', 'info', 'exclude'));
    const matcher = text.trim() ? ignore().add(text) : null;
    this.perFolder.set(folder, matcher);
    return matcher;
  }

  /**
   * Is this one entry ignored, given that its parent folder is not? `rel` uses / and has no leading slash. Your include
   * patterns win over everything, your exclude patterns over .gitignore.
   */
  private ignoredHere(rel: string, isDir: boolean): boolean {
    const probe = isDir ? rel + '/' : rel;
    if (this.forced.ignores(probe)) return false;
    if (this.extra.ignores(probe)) return true;
    const parts = rel.split('/');
    let ignored = false;
    for (let i = 0; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      const m = this.matcher(folder);
      if (!m) continue;
      const below = parts.slice(i).join('/') + (isDir ? '/' : '');
      const result = m.test(below);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  }

  /** Is `rel` (a file, or a folder with isDir) ignored, counting its folders: inside an ignored folder is ignored. */
  isIgnored(rel: string, isDir = false): boolean {
    const parts = rel.split('/').filter(Boolean);
    if (parts[0] === '.git') return true;
    if (!isDir && this.isForced(parts.join('/'))) return false;
    for (let i = 1; i < parts.length; i++) if (this.ignoredHere(parts.slice(0, i).join('/'), true)) return true;
    return this.ignoredHere(parts.join('/'), isDir);
  }

  /** For a walk that already checked the parent folder: is this child ignored? */
  isIgnoredChild(rel: string, isDir: boolean): boolean {
    return rel.split('/')[0] === '.git' || this.ignoredHere(rel, isDir);
  }
}
