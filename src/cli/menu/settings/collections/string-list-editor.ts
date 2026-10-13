import { Theme, type ListItem } from '../../../tui/index.js';
import { CollectionEditor } from './collection-editor.js';

/** A list of strings (project roots, scripts, extra packages ...). */
export class StringListEditor extends CollectionEditor<string[]> {
  protected override noun = 'item';
  protected entries(): ListItem<string>[] {
    return this.value.map((v, i) => ({ value: String(i), label: v || Theme.muted('(empty)') }));
  }
  private async ask(initial: string): Promise<string | undefined> {
    const element = this.node.element!;
    return this.app.text({
      path: this.path,
      label: 'Value',
      about: this.node.description ? [this.node.description] : [],
      initial,
      validate: (v) => element.check(v),
    });
  }
  protected async add(): Promise<void> {
    const v = await this.ask('');
    if (v !== undefined) this.value.push(v);
  }
  protected async open(id: string): Promise<void> {
    const v = await this.ask(this.value[Number(id)]);
    if (v !== undefined) this.value[Number(id)] = v;
  }
  protected remove(id: string): void {
    this.value.splice(Number(id), 1);
  }
  protected override move(id: string, by: number): string {
    const from = Number(id);
    const to = Math.max(0, Math.min(this.value.length - 1, from + by));
    const [item] = this.value.splice(from, 1);
    this.value.splice(to, 0, item);
    return String(to);
  }
}
