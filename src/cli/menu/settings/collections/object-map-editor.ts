import { Theme, type ListItem } from '../../../tui/index.js';
import { CollectionEditor } from './collection-editor.js';
import { summary } from '../format.js';
import { ObjectEditor } from '../object-editor.js';

/** A map of names to objects (agents). */
export class ObjectMapEditor extends CollectionEditor<Record<string, Record<string, unknown>>> {
  protected override noun = 'entry';
  protected entries(): ListItem<string>[] {
    return Object.entries(this.value).map(([k, v]) => ({ value: k, label: k, hint: Theme.muted(summary(v)) }));
  }
  protected async add(): Promise<void> {
    const name = await this.app.text({
      path: this.path,
      label: 'Name',
      validate: (v) =>
        this.value[v] !== undefined
          ? 'That name is there already.'
          : /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)
            ? true
            : 'Letters, digits, . _ and - only.',
    });
    if (name === undefined) return;
    const edited = await new ObjectEditor(
      this.app,
      [...this.path, name],
      this.node.element!,
      this.editor,
      this.key,
    ).run(this.node.element!.initial() as Record<string, unknown>, true);
    if (edited) this.value[name] = edited.value as Record<string, unknown>;
  }
  protected async open(id: string): Promise<void> {
    const edited = await new ObjectEditor(this.app, [...this.path, id], this.node.element!, this.editor, this.key).run(
      this.value[id],
    );
    if (edited) this.value[id] = edited.value as Record<string, unknown>;
  }
  protected remove(id: string): void {
    delete this.value[id];
  }
}
