// Where the menu was left, kept in ~/.agent-sandbox/menu-state.json: the open section and, for each section, its
// category and search. A convenience only: a missing, invalid or unwritable file means the menu opens on Agents.
import path from 'node:path';
import { z } from 'zod';
import { userDir } from '../../core/config/index.js';
import { JsonFile } from '../../shared/io/index.js';
import type { MenuView, ScreenView } from './shell.js';

const ScreenSchema = z.strictObject({
  category: z.string().max(100).optional(),
  search: z.string().max(200).optional(),
});
const MenuStateSchema = z.strictObject({
  section: z.string().max(40),
  screens: z.record(z.string().max(40), ScreenSchema),
});
type MenuState = z.output<typeof MenuStateSchema>;

function stateFile(dir: string): JsonFile<MenuState> {
  return new JsonFile(MenuStateSchema, path.join(dir, 'menu-state.json'));
}

/** The view as it is stored: the section by name, so a menu with other sections still finds its way. */
export function viewToState(view: MenuView, labels: readonly string[]): MenuState {
  const screens: Record<string, ScreenView> = {};
  for (const [label, screen] of Object.entries(view.screens))
    if (labels.includes(label) && (screen.category || screen.search)) screens[label] = screen;
  return { section: labels[view.section] ?? labels[0] ?? '', screens };
}

/** A stored state as a view; a section that no longer exists falls back to the first. */
export function stateToView(state: MenuState, labels: readonly string[]): MenuView {
  const section = labels.indexOf(state.section);
  return {
    section: section < 0 ? 0 : section,
    screens: Object.fromEntries(Object.entries(state.screens).filter(([label]) => labels.includes(label))),
  };
}

/** The view the last run left (undefined when there is none or the file is not valid). */
export function readMenuView(labels: readonly string[], dir: string = userDir()): MenuView | undefined {
  try {
    const state = stateFile(dir).read();
    return state ? stateToView(state, labels) : undefined;
  } catch {
    // The state is a convenience: an unreadable file counts as none.
    return undefined;
  }
}

/** Remembers the view for the next run. Never fails the menu. */
export function saveMenuView(view: MenuView, labels: readonly string[], dir: string = userDir()): void {
  try {
    stateFile(dir).write(viewToState(view, labels));
  } catch {
    // Not remembering is fine.
  }
}
