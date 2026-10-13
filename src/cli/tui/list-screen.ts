// The one list screen every menu is built from: an optional sidebar of categories, a list with section headings and a
// value column, a details pane for the highlighted entry, search (/), ticking several entries, and extra keys a screen
// can add (r = reset, d = delete ...). Arrow keys move; Enter opens; Esc goes back.
import type { FrameParts } from './frame.js';
import type { Screen, Size, Step } from './app.js';
import type { Key } from './terminal.js';
import { Text } from './text.js';
import { Theme } from './theme.js';

export interface ListItem<T> {
  value: T;
  label: string;
  /** Right-hand column: a setting's value, a size, a state. */
  hint?: string;
  description?: string;
  /** Extra lines for the details pane (already formatted). */
  details?: string[];
  /** Heading the entry is listed under (entries with the same section should be next to each other). */
  section?: string;
  /** Sidebar category id. */
  category?: string;
  /** More words search should find it by. */
  keywords?: string;
  /** Why it cannot be picked (shown dim). */
  disabled?: string;
  /** Multi-select: ticked. */
  checked?: boolean;
  /** A glyph before the label. */
  icon?: string;
}

export interface Category {
  id: string;
  label: string;
  description?: string;
}
export interface ListAction {
  key: string;
  label: string;
}
/** Tabs above the list (e.g. which settings file): Tab switches, the screen reopens on the other one. */
export interface Tab {
  label: string;
  badge: string;
  paint: (text: string) => string;
}

export type ListResult<T> =
  | { kind: 'pick'; value: T }
  | { kind: 'back' }
  | { kind: 'action'; key: string; value: T | undefined }
  | { kind: 'multi'; values: T[] }
  | { kind: 'tab'; index: number };

export interface ListOptions<T> {
  path: string[];
  status?: string;
  /** A line or two above the list. */
  intro?: string | string[];
  items: ListItem<T>[];
  categories?: Category[];
  multi?: boolean;
  /** Start on this entry (and its category). */
  startAt?: T;
  startCategory?: string;
  actions?: ListAction[];
  notice?: string;
  empty?: string;
  tabs?: { items: Tab[]; active: number };
  /** What Esc does, for the footer ("back", "quit"). */
  escapeLabel?: string;
}

type Row = { kind: 'section'; text: string } | { kind: 'item'; index: number };

export class ListScreen<T> implements Screen<ListResult<T>> {
  private category = 0;
  private focus: 'side' | 'list' = 'list';
  private cursor = 0;
  private offset = 0;
  private query = '';
  private searching = false;
  private notice: string | undefined;
  private readonly checked: Set<number>;

  constructor(private readonly o: ListOptions<T>) {
    this.notice = o.notice;
    this.checked = new Set(o.items.flatMap((item, i) => (item.checked ? [i] : [])));
    const start = o.startAt === undefined ? -1 : o.items.findIndex((item) => item.value === o.startAt);
    const startCategory = start >= 0 ? o.items[start].category : o.startCategory;
    if (o.categories && startCategory)
      this.category = Math.max(
        0,
        o.categories.findIndex((c) => c.id === startCategory),
      );
    if (start >= 0) this.cursor = Math.max(0, this.visible().indexOf(start));
  }

  /** Indexes of the entries shown now: all matches of the search, else the current category's, else all. */
  private visible(): number[] {
    const all = this.o.items.map((_, i) => i);
    if (this.query.trim()) {
      const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
      const label = (id?: string): string => this.o.categories?.find((c) => c.id === id)?.label ?? '';
      return all.filter((i) => {
        const it = this.o.items[i];
        const hay = [it.label, Text.strip(it.hint ?? ''), it.description, it.keywords, it.section, label(it.category)]
          .join(' ')
          .toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const cat = this.o.categories?.[this.category];
    return cat ? all.filter((i) => this.o.items[i].category === cat.id) : all;
  }

  private rows(visible: number[]): Row[] {
    const rows: Row[] = [];
    let section: string | undefined;
    const searchAll = Boolean(this.query.trim() && this.o.categories);
    for (const index of visible) {
      const it = this.o.items[index];
      const heading = searchAll
        ? [this.o.categories?.find((c) => c.id === it.category)?.label, it.section].filter(Boolean).join(' › ')
        : it.section;
      if (heading && heading !== section) rows.push({ kind: 'section', text: heading });
      section = heading;
      rows.push({ kind: 'item', index });
    }
    return rows;
  }

  render(size: Size): FrameParts {
    const visible = this.visible();
    this.cursor = Math.min(this.cursor, Math.max(0, visible.length - 1));
    const sideWidth = this.o.categories
      ? Math.min(32, Math.max(...this.o.categories.map((c) => Text.width(c.label))) + 7)
      : 0;
    const rest = size.width - 1 - (sideWidth ? sideWidth + 3 : 0);
    const detailsRight = rest >= 100;
    const detailsWidth = detailsRight ? Math.min(52, Math.floor(rest * 0.38)) : rest;
    const listWidth = detailsRight ? rest - detailsWidth - 3 : rest;

    const top: string[] = [];
    if (this.o.tabs)
      top.push(
        ' ' +
          this.o.tabs.items
            .map((tab, i) =>
              i === this.o.tabs!.active
                ? tab.paint(' ' + tab.badge + ' ' + tab.label + ' ')
                : Theme.muted('  ' + tab.label + '  '),
            )
            .join(' ') +
          Theme.muted('   tab switches'),
        '',
      );
    const intro = typeof this.o.intro === 'string' ? [this.o.intro] : (this.o.intro ?? []);
    for (const line of intro) top.push(...Text.wrap(line, size.width - 3).map((l) => ' ' + Theme.muted(l)));
    if (this.searching || this.query)
      top.push(
        ' ' +
          Theme.accent(Theme.glyph.search) +
          ' ' +
          this.query +
          (this.searching ? Theme.accent('▏') : '') +
          Theme.muted('   ' + visible.length + ' match' + (visible.length === 1 ? '' : 'es')),
      );
    if (top.length) top.push('');

    const details = this.detailsLines(visible[this.cursor], detailsWidth);
    const bottomDetails = !detailsRight && size.height - top.length >= 14 ? details.slice(0, 6) : [];
    const rows = this.rows(visible);
    const room = size.height - top.length - (bottomDetails.length ? bottomDetails.length + 1 : 0);
    // A list longer than the room keeps one row for "▲ / ▼ more".
    const listHeight = rows.length > room ? room - 1 : room;
    const cursorRow = rows.findIndex((r) => r.kind === 'item' && r.index === visible[this.cursor]);
    if (cursorRow >= 0) {
      // Keep the heading above the first entry in view, and the cursor inside the window.
      const want = cursorRow > 0 && rows[cursorRow - 1].kind === 'section' ? cursorRow - 1 : cursorRow;
      if (want < this.offset) this.offset = want;
      if (cursorRow >= this.offset + listHeight) this.offset = cursorRow - listHeight + 1;
    }
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - listHeight)));
    const listLines = rows
      .slice(this.offset, this.offset + listHeight)
      .map((row) => this.rowLine(row, visible, listWidth));
    if (!visible.length)
      listLines.push(
        '',
        '  ' +
          Theme.muted(this.query ? 'Nothing matches "' + this.query + '".' : (this.o.empty ?? 'Nothing here yet.')),
      );
    if (rows.length > listHeight) {
      const above = this.offset;
      const below = rows.length - this.offset - listHeight;
      listLines.push(
        Theme.muted(
          '   ' +
            (above > 0 ? '▲ ' + above + ' above' : '') +
            (above > 0 && below > 0 ? '   ' : '') +
            (below > 0 ? '▼ ' + below + ' more' : ''),
        ),
      );
    }

    const sideLines = this.sideLines(sideWidth);
    const body: string[] = [...top];
    const height = Math.max(listLines.length, detailsRight ? details.length : 0, sideLines.length);
    for (let i = 0; i < Math.min(height, size.height - top.length); i++) {
      const side = sideWidth ? Text.fit(sideLines[i] ?? '', sideWidth) + ' ' + Theme.dim(Theme.glyph.vline) + ' ' : '';
      const main = Text.fit(listLines[i] ?? '', listWidth);
      const right = detailsRight ? ' ' + Theme.dim(Theme.glyph.vline) + ' ' + (details[i] ?? '') : '';
      body.push(side + main + right);
    }
    if (bottomDetails.length) {
      // The details sit at the bottom, whatever the length of the list.
      while (body.length < size.height - bottomDetails.length - 1)
        body.push(
          sideWidth
            ? Text.fit(sideLines[body.length - top.length] ?? '', sideWidth) + ' ' + Theme.dim(Theme.glyph.vline)
            : '',
        );
      body.push(Theme.dim(' ' + Theme.glyph.line.repeat(size.width - 3)), ...bottomDetails.map((l) => ' ' + l));
    }
    return { path: this.o.path, status: this.o.status, body, keys: this.keys(), notice: this.notice };
  }

  private rowLine(row: Row, visible: number[], width: number): string {
    if (row.kind === 'section') return ' ' + Theme.accentBold(row.text);
    const it = this.o.items[row.index];
    const selected = visible[this.cursor] === row.index;
    const box = this.o.multi
      ? (this.checked.has(row.index) ? Theme.ok(Theme.glyph.checked) : Theme.muted(Theme.glyph.unchecked)) + ' '
      : '';
    const icon = it.icon ? it.icon + ' ' : '';
    const hint = it.hint ?? '';
    const hintWidth = Math.min(Text.width(hint), Math.floor(width * 0.5));
    const labelWidth = width - 4 - Text.width(box) - Text.width(icon) - (hintWidth ? hintWidth + 2 : 0);
    const label = it.disabled ? Theme.muted(it.label) : it.label;
    const line =
      (selected ? Theme.glyph.pointer : ' ') +
      ' ' +
      box +
      icon +
      Text.fit(label, labelWidth) +
      (hintWidth ? '  ' + Text.fit(hint, hintWidth, 'right') : '') +
      ' ';
    if (!selected) return ' ' + line;
    return this.focus === 'list' ? ' ' + Theme.selected(Text.strip(line)) : ' ' + Theme.accent(Text.strip(line));
  }

  private sideLines(width: number): string[] {
    if (!this.o.categories) return [];
    return this.o.categories.map((cat, i) => {
      const count = this.o.items.filter((it) => it.category === cat.id).length;
      const text = ' ' + Text.fit(cat.label, width - 6) + ' ' + Text.fit(String(count), 3, 'right') + ' ';
      if (i !== this.category) return Theme.muted(text);
      return this.focus === 'side' ? Theme.selected(text) : Theme.accentBold(text);
    });
  }

  private detailsLines(index: number | undefined, width: number): string[] {
    const w = Math.max(10, width - 1);
    if (this.focus === 'side' && this.o.categories) {
      const cat = this.o.categories[this.category];
      return [
        Theme.bold(cat.label),
        ...(cat.description ? Text.wrap(cat.description, w).map((l) => Theme.muted(l)) : []),
      ];
    }
    if (index === undefined) return [];
    const it = this.o.items[index];
    return [
      Theme.bold(Text.truncate(it.label, w)),
      ...(it.description ? Text.wrap(it.description, w).map((l) => Theme.muted(l)) : []),
      ...(it.details?.length ? ['', ...it.details.flatMap((d) => Text.wrap(d, w))] : []),
      ...(it.disabled ? ['', Theme.warn(it.disabled)] : []),
    ];
  }

  private keys(): [string, string][] {
    if (this.searching)
      return [
        ['type', 'to search'],
        ['↑↓', 'move'],
        ['↵', this.o.multi ? 'done' : 'open'],
        ['esc', 'clear search'],
      ];
    return [
      ['↑↓', 'move'],
      ...(this.o.tabs
        ? [['tab', 'switch ' + this.o.tabs.items.map((t) => t.label.toLowerCase()).join(' / ')] as [string, string]]
        : []),
      ...(this.o.categories ? [['←→', 'categories'] as [string, string]] : []),
      ...(this.o.multi
        ? ([
            ['space', 'tick'],
            ['a', 'tick all shown'],
            ['↵', 'done'],
          ] as [string, string][])
        : [['↵', 'open'] as [string, string]]),
      ['/', 'search'],
      ...(this.o.actions ?? []).map((a) => [a.key, a.label] as [string, string]),
      ['esc', this.o.escapeLabel ?? 'back'],
    ];
  }

  /** Programmatic notice (e.g. "Saved") shown until the next key. */
  setNotice(text: string | undefined): void {
    this.notice = text;
  }

  handle(key: Key): Step<ListResult<T>> {
    const visible = this.visible();
    const current = visible[this.cursor];
    this.notice = undefined;
    const move = (by: number): void => {
      this.cursor = Math.max(0, Math.min(visible.length - 1, this.cursor + by));
    };
    if (key.name === 'up') {
      if (this.focus === 'side') this.switchCategory(-1);
      else move(-1);
      return;
    }
    if (key.name === 'down') {
      if (this.focus === 'side') this.switchCategory(1);
      else move(1);
      return;
    }
    if (key.name === 'pageup') {
      move(-10);
      return;
    }
    if (key.name === 'pagedown') {
      move(10);
      return;
    }
    if (key.name === 'home') {
      this.cursor = 0;
      return;
    }
    if (key.name === 'end') {
      this.cursor = visible.length - 1;
      return;
    }
    if (this.searching) {
      if (key.name === 'escape') {
        this.searching = false;
        this.query = '';
        this.cursor = 0;
        return;
      }
      if (key.name === 'backspace') {
        if (this.query) this.query = this.query.slice(0, -1);
        else this.searching = false;
        this.cursor = 0;
        return;
      }
      // In a tick list, space always ticks (even while searching).
      if (key.name !== 'return' && key.text && !(this.o.multi && key.name === 'space')) {
        this.query += key.text;
        this.cursor = 0;
        return;
      }
    }
    if (this.o.tabs && key.name === 'tab') {
      const n = this.o.tabs.items.length;
      return { done: { kind: 'tab', index: (this.o.tabs.active + (key.shift ? n - 1 : 1)) % n } };
    }
    if (this.o.categories && !this.query) {
      if (key.name === 'left' && this.focus === 'list') {
        this.focus = 'side';
        return;
      }
      if ((key.name === 'right' || key.name === 'return') && this.focus === 'side') {
        this.focus = 'list';
        return;
      }
    }
    if (key.name === 'escape' || (key.name === 'backspace' && !this.searching)) {
      if (this.query) {
        this.query = '';
        this.cursor = 0;
        return;
      }
      return { done: { kind: 'back' } };
    }
    if (key.text === '/' || (key.name === 'f' && key.ctrl)) {
      this.searching = true;
      this.focus = 'list';
      return;
    }
    if (this.o.multi) {
      if (key.name === 'space' && current !== undefined) {
        this.toggle(current);
        return;
      }
      if (key.text === 'a') {
        const all = visible.filter((i) => !this.o.items[i].disabled);
        const tick = all.some((i) => !this.checked.has(i));
        all.forEach((i) => (tick ? this.checked.add(i) : this.checked.delete(i)));
        return;
      }
      if (key.name === 'return')
        return {
          done: { kind: 'multi', values: this.o.items.filter((_, i) => this.checked.has(i)).map((it) => it.value) },
        };
    }
    if (
      (key.name === 'return' || key.name === 'right' || (key.name === 'space' && !this.searching)) &&
      current !== undefined &&
      !this.o.multi
    ) {
      const it = this.o.items[current];
      if (it.disabled) {
        this.notice = Theme.warn(it.disabled);
        return;
      }
      return { done: { kind: 'pick', value: it.value } };
    }
    const action = !this.searching && key.text ? this.o.actions?.find((a) => a.key === key.text) : undefined;
    if (action)
      return {
        done: {
          kind: 'action',
          key: action.key,
          value: current === undefined ? undefined : this.o.items[current].value,
        },
      };
    return;
  }

  private toggle(index: number): void {
    if (this.o.items[index].disabled) {
      this.notice = Theme.warn(this.o.items[index].disabled!);
      return;
    }
    if (this.checked.has(index)) this.checked.delete(index);
    else this.checked.add(index);
  }

  private switchCategory(by: number): void {
    const count = this.o.categories?.length ?? 0;
    if (!count) return;
    this.category = (this.category + by + count) % count;
    this.cursor = 0;
    this.offset = 0;
  }
}
