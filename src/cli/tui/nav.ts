// The navigation on the left of every menu screen: the sections as a tree (the open one shows its categories), with
// the way you are standing marked. Narrow terminals get a slim column of numbers instead of names. Pure (tested).
import { Text } from './text.js';
import { Theme } from './theme.js';

export interface NavCategory {
  readonly label: string;
  /** The category open in the list. */
  readonly current: boolean;
}

export interface NavSection {
  readonly label: string;
  /** Something is waiting in this section (unsaved changes). */
  readonly marked?: boolean;
  /** The categories of the open section (other sections are drawn without theirs). */
  readonly categories: readonly NavCategory[];
}

export interface NavState {
  readonly sections: readonly NavSection[];
  /** Index of the open section. */
  readonly active: number;
  /** The navigation has the keyboard (else the list has it). */
  readonly focused: boolean;
  /** A dialog or sub-screen is shown over the menu: everything is drawn grey. */
  readonly dimmed?: boolean;
}

/** Terminals narrower than this get the slim column. */
const SLIM_BELOW = 80;
const SLIM_WIDTH = 5;

export class SideNav {
  /** Columns the navigation takes on a terminal `termWidth` columns wide (without the divider). */
  static width(termWidth: number): number {
    if (termWidth < SLIM_BELOW) return SLIM_WIDTH;
    return termWidth >= 130 ? 28 : 24;
  }

  /** Exactly `height` lines, each `SideNav.width(termWidth)` columns wide. */
  static render(nav: NavState, termWidth: number, height: number): string[] {
    const width = SideNav.width(termWidth);
    const slim = width === SLIM_WIDTH;
    const lines: { text: string; stop: boolean }[] = [];
    nav.sections.forEach((section, i) => {
      const open = i === nav.active;
      const hasCategories = open && section.categories.length > 0;
      const standing = open && !hasCategories;
      lines.push({ text: SideNav.section(nav, section, i, width, slim, standing), stop: standing });
      if (!hasCategories) return;
      section.categories.forEach((cat, c) => {
        const last = c === section.categories.length - 1;
        lines.push({ text: SideNav.category(nav, cat, last, width, slim), stop: cat.current });
      });
    });
    const at = Math.max(
      0,
      lines.findIndex((l) => l.stop),
    );
    const start = lines.length > height ? Math.min(Math.max(0, at - Math.floor(height / 2)), lines.length - height) : 0;
    const shown = lines.slice(start, start + height).map((l) => l.text);
    while (shown.length < height) shown.push(' '.repeat(width));
    return shown;
  }

  private static section(
    nav: NavState,
    section: NavSection,
    index: number,
    width: number,
    slim: boolean,
    standing: boolean,
  ): string {
    const open = index === nav.active;
    const live = !nav.dimmed;
    // The open section has a marker, so it shows without colour.
    const lead = open ? (section.categories.length ? '▾' : Theme.glyph.pointer) : ' ';
    const mark = section.marked ? Theme.changed(Theme.glyph.changed) : ' ';
    const inner = slim
      ? lead + (index + 1) + mark + '  '
      : Text.fit(lead + (index + 1) + ' ' + (open && live ? Theme.bold(section.label) : section.label), width - 3) +
        ' ' +
        mark +
        ' ';
    if (standing && live && nav.focused) return Theme.selected(Text.fit(inner, width));
    if (!live || !open) return Theme.muted(Text.fit(inner, width));
    return nav.focused ? Text.fit(inner, width) : Theme.accent(Text.fit(inner, width));
  }

  private static category(nav: NavState, cat: NavCategory, last: boolean, width: number, slim: boolean): string {
    const live = !nav.dimmed;
    const plain = slim
      ? '  ' + (cat.current ? Theme.glyph.on : Theme.glyph.dot) + '  '
      : '  ' + (cat.current ? Theme.glyph.pointer : last ? '└' : '├') + ' ' + cat.label;
    const line = Text.fit(plain, width);
    if (!cat.current || !live) return Theme.muted(line);
    return nav.focused ? Theme.selected(line) : Theme.accentBold(line);
  }
}
