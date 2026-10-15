import type { App, ListItem } from '../../../tui/index.js';
import { Theme } from '../../../tui/index.js';
import { CollectionEditor } from './collection-editor.js';
import { askPath, type PathKind } from '../path-kind.js';
import type { SchemaNode } from '../schema-node.js';
import type { ValueEditor } from '../value-editor.js';

/** A list of strings (project roots, scripts, extra packages ...). */
export class StringListEditor extends CollectionEditor<string[]> {
  protected override noun = 'item';

  constructor(
    app: App,
    path: string[],
    node: SchemaNode,
    editor: ValueEditor,
    key: string[],
    /** The items are folders or files on this PC: they are picked in the path picker. */
    private readonly pathKind?: PathKind,
    /** What leaving with changes does, when it is not "wait for Ctrl+S". */
    keepNote?: string,
  ) {
    super(app, path, node, editor, key);
    if (pathKind) this.noun = pathKind === 'file' ? 'file' : 'folder';
    if (keepNote) this.keepNote = keepNote;
  }

  protected entries(): ListItem<string>[] {
    return this.value.map((v, i) => ({ value: String(i), label: v || Theme.muted('(empty)') }));
  }
  private async ask(initial: string): Promise<string | undefined> {
    const element = this.node.element!;
    if (this.pathKind)
      return askPath(this.app, {
        path: this.path,
        title: this.pathKind === 'file' ? 'Choose a file' : 'Choose a folder',
        about: this.node.description ? [this.node.description] : [],
        kind: this.pathKind,
        initial,
        validate: (v) => element.check(v),
      });
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
