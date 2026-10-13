import fs from 'node:fs';
import path from 'node:path';
import { splitArgs } from '../args.js';
import { type ArgSpec, type OptionSpec } from '../manifest.js';
import { validNodeSpec, validPythonSpec } from '../validate.js';

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
