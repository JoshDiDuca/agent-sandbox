import { type ListItem } from '../../../tui/index.js';
import { CollectionEditor } from './collection-editor.js';
import { summary } from '../format.js';
import { ObjectEditor } from '../object-editor.js';

/** A list of objects (mapped folders). */
export class ObjectListEditor extends CollectionEditor<Record<string, unknown>[]> {
  protected override noun = 'entry';
  protected entries(): ListItem<string>[] {
    return this.value.map((v, i) => ({ value: String(i), label: summary(v) }));
  }
  protected async add(): Promise<void> {
    const edited = await new ObjectEditor(
      this.app,
      [...this.path, 'New'],
      this.node.element!,
      this.editor,
      this.key,
    ).run(this.node.element!.initial() as Record<string, unknown>, true);
    if (edited) this.value.push(edited.value as Record<string, unknown>);
  }
  protected async open(id: string): Promise<void> {
    const edited = await new ObjectEditor(
      this.app,
      [...this.path, summary(this.value[Number(id)])],
      this.node.element!,
      this.editor,
      this.key,
    ).run(this.value[Number(id)]);
    if (edited) this.value[Number(id)] = edited.value as Record<string, unknown>;
  }
  protected remove(id: string): void {
    this.value.splice(Number(id), 1);
  }
}
