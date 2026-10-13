// One command as a form: its arguments and options listed with their current values, each changed in place, and the
// exact command line it will run shown live (the same line you could type yourself). Built from manifest.ts, so a new
// command or option appears here on its own.
import { humanBytes } from '../../core/disk.js';
import { fail, plainText } from '../../core/util/index.js';
import { listAccounts } from '../../host/profile/index.js';
import { runningSessions } from '../../host/channel/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import { splitArgs } from '../args.js';
import type { Context } from '../commands/context.js';
import { cleanTargetOf, collectDataEntries } from '../commands/data/collect.js';
import { commandLine } from '../history.js';
import { askedWhen, type CommandSpecT, type OptionSpecT } from '../manifest.js';
import { App, Text, Theme, type ListItem } from '../tui/index.js';
import { type Field, optionProblem } from './command-fields.js';

const RUN = '@run';

export class CommandForm {
  /** Answers by field id (arg:<name>, opt:<flag>, json, extra). */
  private readonly values = new Map<string, string[] | boolean>();

  constructor(
    private readonly app: App,
    private readonly ctx: Context,
    private readonly spec: CommandSpecT,
    preset: string[] = [],
  ) {
    for (let i = 0; i < preset.length; i++) {
      const option = spec.options.find((o) => o.flag === preset[i]);
      if (option?.type === 'boolean') this.values.set('opt:' + option.flag, true);
      else if (option)
        this.values.set('opt:' + option.flag, [
          ...((this.values.get('opt:' + option.flag) as string[]) ?? []),
          preset[++i],
        ]);
    }
  }

  /** Values a choices list names, filled in from config and the running sandbox. */
  private choices(choices: OptionSpecT['choices']): string[] {
    if (Array.isArray(choices)) return choices;
    if (choices === 'harnesses') return Object.keys(this.ctx.loaded.config.harnesses);
    if (choices === 'accounts') return listAccounts(this.ctx.storageRoot, this.ctx.dataPath).map((a) => a.name);
    if (choices === 'sessions')
      return isSandboxRunning() ? runningSessions(this.ctx.dataPath).map((s) => plainText(s.id)) : [];
    return [];
  }

  private first(): string {
    return (this.values.get('arg:' + this.spec.args[0]?.name) as string[] | undefined)?.[0] ?? '';
  }

  private fields(): Field[] {
    const first = this.first();
    return [
      ...this.spec.args
        .map((spec, index): Field => ({ kind: 'arg', spec, index }))
        .filter((f) => f.kind === 'arg' && (f.index === 0 || askedWhen(f.spec.when, first))),
      ...this.spec.options
        .filter(
          (o) =>
            !o.noMenu &&
            askedWhen(o.when, first) &&
            !(typeof o.choices === 'string' && !this.choices(o.choices).length),
        )
        .map((spec): Field => ({ kind: 'option', spec })),
      ...(this.spec.json && !(this.spec.name === 'data' && first === 'clean') ? [{ kind: 'json' } as Field] : []),
      ...(this.spec.passthrough ? [{ kind: 'extra' } as Field] : []),
    ];
  }

  private id(f: Field): string {
    return f.kind === 'arg' ? 'arg:' + f.spec.name : f.kind === 'option' ? 'opt:' + f.spec.flag : f.kind;
  }

  /** The command line the form stands for now. */
  argv(): string[] {
    const fields = this.fields();
    const list = (f: Field): string[] => (this.values.get(this.id(f)) as string[] | undefined) ?? [];
    const argv = [this.spec.name, ...fields.filter((f) => f.kind === 'arg').flatMap(list)];
    for (const f of fields) {
      if (f.kind !== 'option') continue;
      const v = this.values.get(this.id(f));
      if (v === true) argv.push(f.spec.flag);
      else if (Array.isArray(v)) for (const x of v) argv.push(f.spec.flag, x);
    }
    if (this.values.get('json') === true) argv.push('--json');
    const extra = list({ kind: 'extra' });
    if (extra.length) argv.push(...(this.spec.passthrough === 'agent' ? ['--', ...extra] : extra));
    return argv;
  }

  /** The name of a required argument that has no value yet. */
  private missing(): string | undefined {
    const field = this.fields().find(
      (f) => f.kind === 'arg' && f.spec.required && !(this.values.get(this.id(f)) as string[] | undefined)?.length,
    );
    return field?.kind === 'arg' ? Text.humanize(field.spec.name) : undefined;
  }

  private item(f: Field): ListItem<string> {
    const v = this.values.get(this.id(f));
    const shown =
      v === true
        ? Theme.ok('On')
        : v === false || v === undefined
          ? Theme.muted(
              (f.kind === 'option' && f.spec.type === 'boolean') || f.kind === 'json'
                ? 'Off'
                : f.kind === 'option' && f.spec.default !== undefined
                  ? 'default ' + f.spec.default
                  : f.kind === 'arg' && f.spec.required
                    ? 'required'
                    : 'not set',
            )
          : Array.isArray(v) && v.length
            ? v.join(' ')
            : Theme.muted('not set');
    if (f.kind === 'arg')
      return {
        value: this.id(f),
        label: Text.humanize(f.spec.name),
        hint: shown,
        description: f.spec.description,
        section: 'What',
        keywords: f.spec.name,
      };
    if (f.kind === 'json')
      return {
        value: 'json',
        label: 'Machine-readable output',
        hint: shown,
        description: 'Print JSON instead of a table (--json).',
        section: 'Output',
      };
    if (f.kind === 'extra')
      return {
        value: 'extra',
        label: this.spec.passthrough === 'agent' ? 'Extra arguments for the agent' : 'Arguments for the command',
        hint: shown,
        description:
          this.spec.passthrough === 'agent'
            ? 'Passed on to the agent, e.g. --continue.'
            : 'The rest of the command line.',
        section: 'Output',
      };
    return {
      value: this.id(f),
      label: f.spec.flag
        .replace(/^--/, '')
        .replace(/-/g, ' ')
        .replace(/^./, (c) => c.toUpperCase()),
      hint: shown,
      description: f.spec.description,
      section: f.spec.advanced ? 'Advanced' : 'Options',
      keywords: f.spec.flag,
    };
  }

  /** Shows the form until you run the command (its argv) or go back (null). */
  async run(): Promise<string[] | null> {
    let focus: string | undefined;
    let notice: string | undefined;
    const path = [Text.humanize(this.spec.name)];
    for (;;) {
      const fields = this.fields();
      const line = commandLine(this.argv());
      const picked = await this.app.list<string>({
        path,
        intro: this.spec.summary.replace(/^./, (c) => c.toUpperCase()) + '.',
        status: Theme.muted('$ ') + Theme.accent(line),
        items: [
          {
            value: RUN,
            label: Theme.ok('▶ Run'),
            hint: Theme.muted(Text.truncate(line, 60)),
            description: 'Runs: ' + line,
            section: 'Run',
          },
          ...fields.map((f) => this.item(f)),
        ],
        startAt: focus,
        actions: [{ key: 'r', label: 'clear' }],
        notice,
      });
      notice = undefined;
      if (picked.kind === 'back') return null;
      if (picked.kind === 'pick' && picked.value === RUN) {
        const missing = this.missing();
        if (missing) {
          notice = Theme.warn(missing + ' is required.');
          continue;
        }
        return this.argv();
      }
      if (picked.kind !== 'pick' && picked.kind !== 'action') continue;
      const field = fields.find((f) => this.id(f) === picked.value);
      if (!field) continue;
      focus = picked.value;
      if (picked.kind === 'action') {
        this.values.delete(this.id(field));
        continue;
      }
      await this.edit(field, path);
    }
  }

  private async edit(f: Field, path: string[]): Promise<void> {
    const id = this.id(f);
    const current = this.values.get(id);
    if (f.kind === 'json' || (f.kind === 'option' && f.spec.type === 'boolean')) {
      this.values.set(id, current !== true);
      return;
    }
    const label = f.kind === 'extra' ? 'Arguments' : f.kind === 'arg' ? Text.humanize(f.spec.name) : f.spec.flag;
    const about = f.kind === 'extra' ? [] : [f.spec.description];
    if (f.kind === 'arg' && this.spec.name === 'data' && f.spec.name === 'targets') {
      const picked = await this.dataTargets(path);
      if (picked) this.values.set(id, picked);
      return;
    }
    const list = f.kind === 'extra' ? [] : this.choices(f.spec.choices);
    const many = (f.kind === 'option' && f.spec.type === 'list') || (f.kind === 'arg' && f.spec.variadic);
    if (list.length && many) {
      const picked = await this.app.list<string>({
        path: [...path, label],
        intro: about,
        multi: true,
        items: list.map((v) => ({ value: v, label: v, checked: Array.isArray(current) && current.includes(v) })),
      });
      if (picked.kind === 'multi') this.values.set(id, picked.values);
      return;
    }
    if (list.length) {
      const optional = !(f.kind === 'arg' && f.spec.required);
      const picked = await this.app.choose<string>(
        [...path, label],
        about.join(' '),
        [
          ...list.map((v) => ({ value: v, label: v })),
          ...(optional ? [{ value: '', label: Theme.muted('(not set)') }] : []),
        ],
        Array.isArray(current) ? current[0] : undefined,
      );
      if (picked !== undefined) {
        if (picked === '') this.values.delete(id);
        else this.values.set(id, [picked]);
      }
      return;
    }
    if (f.kind === 'arg' && typeof f.spec.choices === 'string')
      fail(
        'There is nothing to choose from: no ' + f.spec.choices + ' yet.',
        f.spec.choices === 'accounts'
          ? 'Sign in inside the sandbox, then run: sandbox account save <name>'
          : 'Start one first (sandbox claude).',
      );
    const typed = await this.app.text({
      path: [...path, label],
      label,
      about,
      allowEmpty: true,
      initial: Array.isArray(current)
        ? many || f.kind === 'extra'
          ? current.map((x) => (/\s/.test(x) ? '"' + x + '"' : x)).join(' ')
          : current[0]
        : '',
      validate: (v) => (f.kind === 'option' ? (optionProblem(f.spec, v) ?? true) : true),
    });
    if (typed === undefined) return;
    const value = many || f.kind === 'extra' ? splitArgs(typed) : typed.trim() ? [typed.trim()] : [];
    if (value.length) this.values.set(id, value);
    else this.values.delete(id);
  }

  /** `data clean` targets, ticked from a list with their sizes (never "all": that is typed on purpose). */
  private async dataTargets(path: string[]): Promise<string[] | undefined> {
    const rows = collectDataEntries(this.ctx.dataPath, this.ctx.storageRoot).flatMap((e) => {
      const target = cleanTargetOf(e);
      return target ? [{ target, bytes: e.bytes }] : [];
    });
    if (!rows.length) {
      await this.app.message({ path, title: 'Nothing is saved yet', lines: ['There is nothing to delete.'] });
      return undefined;
    }
    const picked = await this.app.list<string>({
      path: [...path, 'Delete what'],
      intro: 'Tick what to delete (space), then Enter. You confirm once more before anything is deleted.',
      multi: true,
      items: rows.map((r) => ({ value: r.target, label: r.target, hint: humanBytes(r.bytes) })),
    });
    return picked.kind === 'multi' && picked.values.length ? picked.values : undefined;
  }
}
