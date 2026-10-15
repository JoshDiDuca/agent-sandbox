// A full screen for choosing a folder (or a file): the path on top (type it, Tab completes), the folders below to
// browse with the arrow keys, drives with their free space, new folders, a filter. Links are shown but never opened.
import fs from 'node:fs';
import path from 'node:path';
import { freeBytesAt, humanBytes } from '../../../core/disk.js';
import type { FrameParts } from '../frame.js';
import type { KeyHint } from '../key-bar.js';
import type { Screen, Size, Step } from '../screen.js';
import type { Key } from '../terminal.js';
import { Text } from '../text.js';
import { Theme } from '../theme.js';
import { paragraphs } from './paragraphs.js';
import {
  completeInput,
  folderNameProblem,
  listDrives,
  listFolder,
  narrow,
  parentOf,
  splitInput,
  withSeparator,
  type Listing,
  type PickEntry,
} from './path-listing.js';

const win = path.win32;

export interface PathPickerOptions {
  path: string[];
  title: string;
  about?: string[];
  /** The path in the input at first (also where the browser starts). */
  initial?: string;
  /** Show files (dim) and let them be picked; folders only by default. */
  files?: boolean;
  /** Label of the choose key, e.g. "use this folder". */
  use?: string;
  /** true = fine, a string = why this path cannot be chosen. */
  validate?: (path: string) => true | string;
  /** Typed words that are fine as they are (a setting that also takes "auto"). */
  literals?: readonly string[];
  /** A relative path may be typed too (it is kept as typed, not made absolute). */
  relative?: boolean;
}

type Mode = 'input' | 'browse' | 'filter' | 'name';

/** Resolves to the chosen path, or undefined when you press Esc. */
export class PathPickerScreen implements Screen<string | undefined> {
  private mode: Mode = 'input';
  private input: string;
  private cursor: number;
  private dir = '';
  private listing: Listing = { entries: [], more: 0 };
  private loadedDir: string | null = null;
  private selected = 0;
  private scroll = 0;
  private filter = '';
  private newName = '';
  private problem: string | undefined;
  private notice: string | undefined;
  private rows = 10;

  constructor(private readonly o: PathPickerOptions) {
    this.input = o.initial ?? '';
    this.cursor = this.input.length;
    this.syncListing();
  }

  render(size: Size): FrameParts {
    const width = Math.min(size.width - 4, 100);
    const inner = width - 4;
    const typing = this.mode === 'input';
    const frame = (t: string): string => (typing ? Theme.accent(t) : Theme.muted(t));
    const start = Math.max(0, this.cursor - inner + 1);
    const shown = this.input.slice(start, start + inner);
    const before = shown.slice(0, this.cursor - start);
    const at = shown[this.cursor - start] ?? ' ';
    const after = shown.slice(this.cursor - start + 1);
    const cursor = typing ? (Theme.colour ? '\x1b[7m' + at + '\x1b[27m' : '_') : at;
    const field = this.input === '' && !typing ? Theme.muted('type a path or pick below') : before + cursor + after;
    const verdict = this.verdict();
    const head = [
      '',
      '  ' + Theme.bold(this.o.title),
      ...(this.o.about?.length ? paragraphs(this.o.about, size.width).map((l) => Theme.muted(l)) : []),
      '  ' + frame('╭' + '─'.repeat(width - 2) + '╮'),
      '  ' + frame('│') + ' ' + Text.fit(field, inner) + ' ' + frame('│'),
      '  ' + frame('╰' + '─'.repeat(width - 2) + '╯'),
      '  ' + this.verdictLine(verdict),
      '  ' + Theme.muted(this.where()),
    ];
    const tail = this.mode === 'name' ? 3 : 0;
    this.rows = Math.max(3, size.height - head.length - tail - 1);
    const visible = this.visible();
    this.keepSelectedInView(visible.length);
    const lines = visible
      .slice(this.scroll, this.scroll + this.rows)
      .map((e, i) => this.row(e, this.scroll + i, size.width));
    if (!visible.length)
      lines.push(
        '  ' + Theme.muted(this.listing.error ?? (this.filter ? 'Nothing matches the filter.' : 'Nothing here.')),
      );
    if (this.listing.more && this.scroll + this.rows >= visible.length)
      lines.push(
        '  ' +
          Theme.muted(Theme.glyph.more + ' ' + this.listing.more + ' more (type more of the name to narrow the list)'),
      );
    const body = [...head, ...lines];
    if (this.mode === 'name')
      body.push('', '  New folder name: ' + this.newName + (Theme.colour ? '\x1b[7m \x1b[27m' : '_'));
    return { path: this.o.path, body, keys: this.keys(), notice: this.notice };
  }

  async handle(key: Key): Promise<Step<string | undefined>> {
    this.notice = undefined;
    if (key.ctrl && key.name === 's') return this.choose(this.candidate());
    if (key.ctrl && key.name === 'return') return this.choose(this.candidate());
    if (key.ctrl && key.name === 'n') return this.startName();
    switch (this.mode) {
      case 'input':
        return this.typing(key);
      case 'browse':
        return this.browsing(key);
      case 'filter':
        return this.filtering(key);
      case 'name':
        return this.naming(key);
    }
  }

  // ---- what is shown ----

  /** The entries on screen: the folder's, narrowed by what is typed after the last backslash and by the filter. */
  private visible(): PickEntry[] {
    const prefix = this.mode === 'input' || this.dirIsTyped() ? splitInput(this.input).prefix : '';
    const base = narrow(this.listing.entries, prefix, this.filter);
    const up: PickEntry[] = this.dir === '' ? [] : [{ kind: 'up', name: '..', path: parentOf(this.dir) }];
    return this.filter || prefix ? base : [...up, ...base];
  }

  private dirIsTyped(): boolean {
    return win.resolve(splitInput(this.input).dir || '.').toLowerCase() === win.resolve(this.dir || '.').toLowerCase();
  }

  private row(e: PickEntry, index: number, width: number): string {
    const on = this.mode !== 'input' && index === this.selected;
    const mark = on ? Theme.glyph.pointer : ' ';
    let text: string;
    switch (e.kind) {
      case 'drive':
        text = e.name + '   ' + Theme.muted(e.detail ?? '');
        break;
      case 'up':
        text = Theme.glyph.back + ' ' + Theme.muted('up one folder');
        break;
      case 'dir':
        text = Theme.glyph.folder + ' ' + e.name;
        break;
      case 'link':
        text = Theme.muted(Theme.glyph.folder + ' ' + e.name + '  (a link: not opened)');
        break;
      case 'file':
        text = Theme.muted('  ' + e.name);
        break;
    }
    const line = ' ' + mark + ' ' + text;
    return on ? Theme.selected(Text.fit(line, Math.min(width - 2, 100))) : line;
  }

  private where(): string {
    if (this.dir === '') return 'This PC: pick a drive';
    const free = freeBytesAt(this.dir);
    const count = this.listing.entries.length + (this.listing.more || 0);
    const drive = win.parse(win.resolve(this.dir)).root;
    return (
      this.dir +
      '  ' +
      Theme.glyph.dot +
      '  ' +
      count +
      (this.o.files ? ' items' : ' folders') +
      (free === null ? '' : '  ' + Theme.glyph.dot + '  ' + humanBytes(free) + ' free on ' + drive)
    );
  }

  private verdict(): true | string {
    const target = this.candidate();
    if (!target) return 'Type a ' + (this.o.files ? 'file' : 'folder') + ', or pick one below.';
    if (this.kept(target)) return this.o.validate?.(target) ?? true;
    if (!win.isAbsolute(target)) return 'Type a full path, like D:\\Sandbox.';
    return this.o.validate?.(target) ?? true;
  }

  private verdictLine(verdict: true | string): string {
    if (this.problem) return Theme.error(Theme.glyph.cross + ' ' + this.problem);
    const target = this.candidate();
    if (verdict === true)
      return (
        Theme.ok(Theme.glyph.ok) + ' ' + Theme.muted((this.o.use ? 'Will ' + this.o.use + ': ' : 'Will use: ') + target)
      );
    return target ? Theme.warn(Theme.glyph.cross + ' ' + verdict) : Theme.muted(verdict);
  }

  private keys(): KeyHint[] {
    const use = this.o.use ?? 'use this folder';
    switch (this.mode) {
      case 'input':
        return [
          ['↵', 'choose', 0],
          ['tab', 'complete'],
          ['↓', 'browse'],
          ['esc', 'cancel', 0],
          ['ctrl+u', 'clear', 9],
        ];
      case 'browse':
        return [
          ['↵ →', 'open', 1],
          ['←', 'up', 2],
          ['s', use, 0],
          ['n', 'new folder', 3],
          ['/', 'filter', 4],
          ['tab', 'type a path', 5],
          ['esc', 'cancel', 0],
        ];
      case 'filter':
        return [
          ['↵', 'keep filter'],
          ['esc', 'clear', 0],
        ];
      case 'name':
        return [
          ['↵', 'create', 0],
          ['esc', 'cancel', 0],
        ];
    }
  }

  // ---- what a path means ----

  /** What choosing now would pick. In the browser a highlighted folder (or file) wins over the folder being shown. */
  private candidate(): string {
    if (this.mode === 'browse' || this.mode === 'filter') {
      const entry = this.visible()[this.selected];
      if (entry && (entry.kind === 'dir' || (entry.kind === 'file' && this.o.files))) return entry.path;
      return this.dir === '' ? '' : this.dir.replace(/[\\/]+$/, '') || this.dir;
    }
    const text = this.input.trim();
    return text.length > 3 ? text.replace(/[\\/]+$/, '') : text;
  }

  private choose(target: string): Step<string | undefined> {
    const verdict = this.verdict();
    if (verdict !== true) {
      this.problem = verdict;
      return;
    }
    return { done: this.kept(target) ? target : win.resolve(target) };
  }

  /** Is this typed text kept as typed: one of the allowed words, or a relative path where those are allowed? */
  private kept(target: string): boolean {
    return (this.o.literals ?? []).includes(target) || Boolean(this.o.relative && !win.isAbsolute(target));
  }

  // ---- the listing ----

  /** Reads the folder the input names (only when it changed), keeping what was typed as a filter. */
  private syncListing(): void {
    const { dir } = splitInput(this.input);
    this.openDir(dir === '' || fs.existsSync(dir) ? dir : this.dir === '' ? '' : this.dir);
  }

  private openDir(dir: string): void {
    if (dir === this.loadedDir) return;
    this.loadedDir = dir;
    this.dir = dir;
    this.listing = dir === '' ? { entries: listDrives(), more: 0 } : listFolder(dir, this.o.files ?? false);
    this.selected = 0;
    this.scroll = 0;
  }

  private go(dir: string): void {
    this.filter = '';
    this.openDir(dir);
    this.input = withSeparator(dir);
    this.cursor = this.input.length;
    this.problem = undefined;
  }

  private keepSelectedInView(count: number): void {
    this.selected = Math.max(0, Math.min(count - 1, this.selected));
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + this.rows) this.scroll = this.selected - this.rows + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, count - this.rows)));
  }

  // ---- keys ----

  private typing(key: Key): Step<string | undefined> {
    if (key.name === 'escape') return { done: undefined };
    if (key.name === 'return') return this.enterInput();
    if (key.name === 'down' || key.name === 'pagedown') {
      this.mode = 'browse';
      return;
    }
    if (key.name === 'tab') {
      const next = completeInput(this.input, this.listing.entries);
      this.edit(next, next.length);
      return;
    }
    if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === 'right') this.cursor = Math.min(this.input.length, this.cursor + 1);
    else if (key.name === 'home') this.cursor = 0;
    else if (key.name === 'end') this.cursor = this.input.length;
    else if (key.name === 'backspace') {
      if (this.cursor > 0)
        this.edit(this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor), this.cursor - 1);
    } else if (key.name === 'delete')
      this.edit(this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1), this.cursor);
    else if (key.ctrl && key.name === 'u') this.edit('', 0);
    else if (key.text) {
      const add = key.text.replace(/[\r\n]/g, '').replace(/\//g, '\\');
      this.edit(this.input.slice(0, this.cursor) + add + this.input.slice(this.cursor), this.cursor + add.length);
    }
    return;
  }

  private edit(next: string, cursor: number): void {
    this.input = next;
    this.cursor = Math.max(0, Math.min(next.length, cursor));
    this.problem = undefined;
    this.syncListing();
    this.selected = 0;
    this.scroll = 0;
  }

  /** A path ending in a backslash is opened to look inside; any other typed path is chosen. */
  private enterInput(): Step<string | undefined> {
    const text = this.input.trim();
    if (text === '') {
      this.problem = 'Type a ' + (this.o.files ? 'file' : 'folder') + ', or press ↓ to browse.';
      return;
    }
    if (/[\\/]$/.test(text) || /^[A-Za-z]:$/.test(text)) {
      const { dir } = splitInput(text);
      if (fs.existsSync(dir)) this.go(dir);
      else this.problem = 'No such folder: ' + dir;
      return;
    }
    return this.choose(this.candidate());
  }

  private browsing(key: Key): Step<string | undefined> {
    const list = this.visible();
    const move = (by: number): void => {
      this.selected = Math.max(0, Math.min(list.length - 1, this.selected + by));
    };
    if (key.name === 'escape') return { done: undefined };
    if (key.name === 'up') {
      if (this.selected === 0) this.mode = 'input';
      else move(-1);
    } else if (key.name === 'down') move(1);
    else if (key.name === 'pageup') move(-this.rows);
    else if (key.name === 'pagedown') move(this.rows);
    else if (key.name === 'home') this.selected = 0;
    else if (key.name === 'end') this.selected = Math.max(0, list.length - 1);
    else if (key.name === 'return' || key.name === 'right') return this.open(list[this.selected]);
    else if (key.name === 'left' || key.name === 'backspace') this.go(parentOf(this.dir));
    else if (key.name === 'tab') this.mode = 'input';
    else if (key.text === 's') return this.choose(this.candidate());
    else if (key.text === 'n') return this.startName();
    else if (key.text === '/') {
      this.mode = 'filter';
      this.filter = '';
      this.selected = 0;
    }
    return;
  }

  private open(entry: PickEntry | undefined): Step<string | undefined> {
    if (!entry) return;
    if (entry.kind === 'link') {
      this.notice = 'That is a link; it is not opened. Pick a normal folder.';
      return;
    }
    if (entry.kind === 'file') return this.choose(entry.path);
    this.go(entry.path);
    return;
  }

  private filtering(key: Key): Step<string | undefined> {
    if (key.name === 'escape') {
      this.filter = '';
      this.mode = 'browse';
      this.selected = 0;
      return;
    }
    if (key.name === 'return') {
      this.mode = 'browse';
      return;
    }
    if (key.name === 'up') this.selected = Math.max(0, this.selected - 1);
    else if (key.name === 'down') this.selected++;
    else if (key.name === 'backspace') {
      this.filter = this.filter.slice(0, -1);
      this.selected = 0;
    } else if (key.text) {
      this.filter += key.text;
      this.selected = 0;
    }
    return;
  }

  private startName(): Step<string | undefined> {
    if (this.dir === '') {
      this.notice = 'Open a drive first.';
      return;
    }
    this.mode = 'name';
    this.newName = '';
    return;
  }

  private naming(key: Key): Step<string | undefined> {
    if (key.name === 'escape') {
      this.mode = 'browse';
      return;
    }
    if (key.name === 'backspace') this.newName = this.newName.slice(0, -1);
    else if (key.name === 'return') {
      const problem = folderNameProblem(this.newName);
      if (problem) {
        this.notice = problem;
        return;
      }
      const made = win.join(this.dir, this.newName.trim());
      try {
        fs.mkdirSync(made);
      } catch (e) {
        this.notice = 'Could not create it: ' + (e instanceof Error ? e.message : String(e));
        return;
      }
      this.mode = 'browse';
      this.loadedDir = null;
      this.go(made);
    } else if (key.text) this.newName += key.text;
    return;
  }
}
