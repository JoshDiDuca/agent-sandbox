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
  /** Space flips this entry (an on/off setting): the footer says so while it is highlighted. */
  flip?: boolean;
}

export interface Category {
  id: string;
  label: string;
  description?: string;
}
export interface ListAction<T = unknown> {
  key: string;
  label: string;
  /** Only while an entry this accepts is highlighted: the key bar and the key itself ignore it otherwise. */
  applies?: (value: T) => boolean;
  /** Pressed with Ctrl (ctrl+s ...); works while searching too. */
  ctrl?: boolean;
  /** How long it survives in a narrow footer: 0 never goes, bigger goes earlier (default 2). */
  importance?: number;
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
  /** Multi-select where Enter ticks too and the screen never finishes by itself (the page saves with a key). */
  enterTicks?: boolean;
  /** Start on this entry (and its category). */
  startAt?: T;
  startCategory?: string;
  /** Start with this search typed (it shows every match in all categories; Esc clears it). */
  startQuery?: string;
  /** Extra keys; a function picks them by the open category. */
  actions?: ListAction<T>[] | ((category: string | undefined) => ListAction<T>[]);
  notice?: string;
  empty?: string;
  tabs?: { items: Tab[]; active: number };
  /** What Esc does, for the footer ("back", "quit"). */
  escapeLabel?: string;
  /** What Enter does, for the footer ("open", "edit", "start"); a function picks it by entry ("": none). */
  enterLabel?: string | ((category: string | undefined, value: T | undefined) => string);
  /** Where the categories are listed: in a sidebar of the list itself (default) or in the menu's own navigation. */
  categoryNav?: 'own' | 'external';
}
