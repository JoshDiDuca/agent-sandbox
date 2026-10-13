import _ from 'lodash';
import { type App, Text, Theme } from '../../tui/index.js';
import { type SchemaNode } from './schema-node.js';
import type { ValueEditor, Edited } from './value-editor.js';
import { SAVE } from './editor-actions.js';
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
        items: [
          {
            value: SAVE,
            label:
              problem === true
                ? dirty
                  ? Theme.ok(Theme.glyph.ok + ' Save')
                  : Theme.muted(Theme.glyph.ok + ' Done (no changes)')
                : Theme.warn(Theme.glyph.cross + ' Not complete yet'),
            description: problem === true ? undefined : problem,
            section: 'Actions',
          },
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
      if (picked.kind === 'pick' && picked.value === SAVE) {
        if (problem !== true) {
          notice = Theme.warn(problem);
          continue;
        }
        return dirty ? { value } : undefined;
      }
      const name = picked.kind === 'pick' || picked.kind === 'action' ? picked.value : undefined;
      if (!name || name === SAVE) continue;
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
