import _ from 'lodash';
import { type App, Text, Theme } from '../../tui/index.js';
import { type SchemaNode } from './schema-node.js';
import type { ValueEditor, Edited } from './value-editor.js';
import { formatValue } from './format.js';

/** One object as a form: each field with its value, Enter to change it, r to clear an optional one. */
export class ObjectEditor {
  constructor(
    private readonly app: App,
    private readonly path: string[],
    private readonly node: SchemaNode,
    private readonly editor: ValueEditor,
  ) {}

  async run(start: Record<string, unknown>, isNew = false): Promise<Edited> {
    const value = structuredClone(start);
    let focus: string | undefined;
    let notice: string | undefined;
    for (;;) {
      const dirty = isNew || !_.isEqual(value, start);
      const problem = this.node.check(value);
      const fields = this.node.children();
      const picked = await this.app.list<string>({
        path: this.path,
        intro: this.node.description,
        notice,
        status: problem === true ? undefined : Theme.warn(Theme.glyph.cross + ' Not complete yet: ' + problem),
        items: [
          ...fields.map(([name, field]) => ({
            value: name,
            label: Text.humanize(name),
            hint: formatValue(value[name]),
            description: field.description,
            section: 'Fields',
          })),
        ],
        startAt: focus,
        actions: [{ key: 'r', label: 'clear' }],
      });
      notice = undefined;
      if (picked.kind === 'back') {
        // A finished form is handed back to be staged; an unfinished one is dropped after asking.
        if (!dirty) return undefined;
        if (problem === true) return { value };
        if (
          await this.app.ask(
            'Leave without finishing?',
            [problem, 'Your changes to this form are lost.'],
            'Discard',
            true,
          )
        )
          return undefined;
        continue;
      }
      const name = picked.kind === 'pick' || picked.kind === 'action' ? picked.value : undefined;
      if (!name) continue;
      focus = name;
      const field = this.node.child(name)!;
      if (picked.kind === 'action') {
        delete value[name];
        continue;
      }
      const edited = await this.editor.edit([...this.path, Text.humanize(name)], [name], field, value[name]);
      if (edited) value[name] = edited.value;
    }
  }
}
