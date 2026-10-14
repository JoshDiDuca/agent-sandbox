import _ from 'lodash';
import { type App, Theme, type ListItem } from '../../../tui/index.js';
import { type SchemaNode } from '../schema-node.js';
import type { ValueEditor, Edited } from '../value-editor.js';
import { ADD } from '../editor-actions.js';

/**
 * The shared shape of the list and map editors: a working copy shown as a list with "Add" at the top, Enter to change
 * an entry, d to delete it. Esc hands the working copy back to be staged (no Save row).
 */
export abstract class CollectionEditor<C> {
  protected value!: C;
  private original!: C;

  constructor(
    protected readonly app: App,
    protected readonly path: string[],
    protected readonly node: SchemaNode,
    protected readonly editor: ValueEditor,
  ) {}

  protected abstract entries(): ListItem<string>[];
  protected abstract add(): Promise<void>;
  protected abstract open(id: string): Promise<void>;
  protected abstract remove(id: string): void;
  protected move?(id: string, by: number): string | undefined;
  protected noun = 'entry';

  async run(start: C): Promise<Edited> {
    this.original = structuredClone(start);
    this.value = structuredClone(start);
    let focus: string | undefined;
    for (;;) {
      const dirty = !_.isEqual(this.value, this.original);
      const entries = this.entries();
      const picked = await this.app.list<string>({
        path: this.path,
        intro: this.node.description,
        status: dirty
          ? Theme.changed(Theme.glyph.changed + ' changed: Esc keeps it for saving with Ctrl+S')
          : undefined,
        items: [
          { value: ADD, label: '+ Add ' + this.noun, section: 'Actions' },
          ...entries.map((e) => ({
            ...e,
            section: entries.length + ' ' + this.noun + (entries.length === 1 ? '' : 's'),
          })),
        ],
        startAt: focus,
        actions: [
          { key: 'd', label: 'delete' },
          ...(this.move
            ? [
                { key: 'u', label: 'move up' },
                { key: 'j', label: 'move down' },
              ]
            : []),
        ],
        empty: 'No ' + this.noun + 's yet.',
      });
      // Leaving keeps the working copy: the caller stages it, and nothing is written until Ctrl+S.
      if (picked.kind === 'back') return dirty ? { value: this.value } : undefined;
      if (picked.kind === 'pick' && picked.value === ADD) {
        await this.add();
        continue;
      }
      const id = picked.kind === 'pick' || picked.kind === 'action' ? picked.value : undefined;
      if (id === undefined || id === ADD) continue;
      focus = id;
      if (picked.kind === 'pick') await this.open(id);
      else if (picked.kind === 'action' && picked.key === 'd') this.remove(id);
      else if (picked.kind === 'action' && this.move) focus = this.move(id, picked.key === 'u' ? -1 : 1) ?? id;
    }
  }
}
