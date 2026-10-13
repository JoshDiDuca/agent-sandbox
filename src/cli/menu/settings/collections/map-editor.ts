import { type ListItem } from '../../../tui/index.js';
import { CollectionEditor } from './collection-editor.js';
import { formatValue } from '../format.js';

/** A map of names to simple values (environment variables). */
export class MapEditor extends CollectionEditor<Record<string, unknown>> {
  protected override noun = 'variable';
  protected entries(): ListItem<string>[] {
    return Object.entries(this.value).map(([k, v]) => ({ value: k, label: k, hint: formatValue(v) }));
  }
  protected async add(): Promise<void> {
    const name = await this.app.text({
      path: this.path,
      label: 'Name',
      about: ['Letters, digits and _ only, e.g. NPM_CONFIG_REGISTRY.'],
      validate: (v) =>
        this.value[v] !== undefined
          ? 'That name is there already.'
          : /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)
            ? true
            : 'Letters, digits and _ only.',
    });
    if (name === undefined) return;
    const edited = await this.editor.edit(
      [...this.path, name],
      [name],
      this.node.element!,
      this.node.element!.initial(),
    );
    if (edited) this.value[name] = edited.value;
  }
  protected async open(id: string): Promise<void> {
    const edited = await this.editor.edit([...this.path, id], [id], this.node.element!, this.value[id]);
    if (edited) this.value[id] = edited.value;
  }
  protected remove(id: string): void {
    delete this.value[id];
  }
}
