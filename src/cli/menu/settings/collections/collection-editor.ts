import _ from 'lodash';
import { type App, Theme, type ListItem } from '../../../tui/index.js';
import { type SchemaNode } from '../schema-node.js';
import type { ValueEditor, Edited } from '../value-editor.js';
import { SAVE, ADD } from '../editor-actions.js';

/**
 * The shared shape of the list and map editors: a working copy shown as a list with "Save" and "Add" at the top, Enter
 * to change an entry, d to delete it. Esc with unsaved changes asks first.
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
        items: [
          {
            value: SAVE,
            label: dirty
              ? Theme.ok(Theme.glyph.ok + ' Save changes')
              : Theme.muted(Theme.glyph.ok + ' Done (no changes)'),
            section: 'Actions',
          },
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
      if (picked.kind === 'back') {
        if (
          !dirty ||
          (await this.app.confirm({
            path: this.path,
            question: 'Discard your changes?',
            yes: 'Discard',
            no: 'Keep editing',
            initial: false,
            danger: true,
          }))
        )
          return undefined;
        continue;
      }
      if (picked.kind === 'pick' && picked.value === SAVE) return dirty ? { value: this.value } : undefined;
      if (picked.kind === 'pick' && picked.value === ADD) {
        await this.add();
        continue;
      }
      const id = picked.kind === 'pick' || picked.kind === 'action' ? picked.value : undefined;
      if (id === undefined || id === SAVE || id === ADD) continue;
      focus = id;
      if (picked.kind === 'pick') await this.open(id);
      else if (picked.kind === 'action' && picked.key === 'd') this.remove(id);
      else if (picked.kind === 'action' && this.move) focus = this.move(id, picked.key === 'u' ? -1 : 1) ?? id;
    }
  }
}
