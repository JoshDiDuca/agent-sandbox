// What the command form knows about a field: what to call it, how its description reads once the form is filtered by
// action, and what kind of value it takes (a folder, a file, a number ...). Pure, so the form and its tests share it.
import fs from 'node:fs';
import path from 'node:path';
import { splitArgs } from '../args.js';
import { type ArgSpec, type OptionSpec } from '../manifest.js';
import { Text } from '../tui/index.js';
import { validNodeSpec, validPythonSpec } from '../validate.js';
import type { PathKind } from './settings/path-kind.js';

/** What an option accepts, checked while typing (undefined = fine). */
export function optionProblem(o: OptionSpec, v: string): string | undefined {
  if (v === '') return undefined;
  if (o.type === 'number' && !(Number(v) > 0)) return 'Enter a number greater than 0.';
  if (o.flag === '--node' && !validNodeSpec(v)) return 'Use a number like 22 or 22.11.0, or lts, latest.';
  if (o.flag === '--python' && !validPythonSpec(v)) return 'Use 3, 3.12 or 3.12.4.';
  if (o.value === 'dir' && !fs.existsSync(path.resolve(v))) return 'That folder does not exist.';
  if (o.value === 'file') {
    const missing = splitArgs(v).find((f) => !fs.existsSync(path.resolve(f)));
    if (missing) return missing + ' does not exist.';
  }
  return undefined;
}

export type Field =
  | { kind: 'arg'; spec: ArgSpec; index: number }
  | { kind: 'option'; spec: OptionSpec }
  | { kind: 'json' }
  | { kind: 'extra' };

/** Plain names for arguments whose own name is a code word. */
const ARG_LABELS: Readonly<Record<string, string>> = {
  id: 'Session',
  action: 'What to do',
  targets: 'What to delete',
  suite: 'Test suites',
  value: 'Value',
  folder: 'Folder',
  command: 'Command',
};

/** The name of an option in the form: its plain label, else the flag made readable (never the raw flag). */
export function optionLabel(o: OptionSpec): string {
  return o.label ?? Text.humanize(o.flag.replace(/^--/, ''));
}

/** The name of an argument in the form. */
export function argLabel(a: ArgSpec): string {
  return ARG_LABELS[a.name] ?? Text.humanize(a.name);
}

const upper = (text: string): string => text.replace(/^./, (c) => c.toUpperCase());

/** A summary as a sentence for the top of the form: "(beta) your sandbox ..." reads "Beta: your sandbox ...". */
export function plainSummary(summary: string): string {
  const beta = /^\((beta)\)\s*(.*)$/i.exec(summary);
  return upper(beta ? 'Beta: ' + beta[2] : summary) + '.';
}

/**
 * A description for the form. A leading "(rename)" / "(save)" names the action it belongs to: the form only asks it for
 * that action, so the prefix is dropped. Any other prefix "(claude)" becomes "For claude: ...".
 */
export function plainDescription(text: string, actions: readonly string[]): string {
  const m = /^\(([^)]+)\)\s*(.*)$/.exec(text);
  if (!m) return upper(text);
  const [, tag, rest] = m;
  return actions.includes(tag.split(/[ /]/)[0]) ? upper(rest) : 'For ' + tag + ': ' + rest;
}

/** The action a description names with a leading "(action)", when it is one of `actions`. */
export function actionOf(text: string, actions: readonly string[]): string | undefined {
  const tag = /^\(([^)\s/]+)[^)]*\)/.exec(text)?.[1];
  return tag && actions.includes(tag) ? tag : undefined;
}

/** A folder or file option (a placeholder of dir / file), or one known by name. */
export function optionPathKind(o: OptionSpec): PathKind | undefined {
  if (o.value === 'dir' || o.value === 'folder' || o.flag === '--restore') return 'dir';
  if (o.value === 'file' || o.flag === '--config') return 'file';
  return undefined;
}

/** A folder or file argument; `first` is the answer to the command's first argument (the action). */
export function argPathKind(a: ArgSpec, command: string, first: string): PathKind | undefined {
  if (['folder', 'dir', 'directory'].includes(a.name)) return 'dir';
  if (['file', 'path'].includes(a.name)) return 'file';
  if (command === 'projects' && a.name === 'value' && ['add', 'remove', 'include', 'exclude'].includes(first))
    return 'dir';
  return undefined;
}
