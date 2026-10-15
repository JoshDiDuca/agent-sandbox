// The repair log: what was found, what was changed, and what each check said before and after. One text file per run in
// <storage>\logs, so there is a record of exactly what repair did to this PC.
import fs from 'node:fs';
import path from 'node:path';
import { assertNoLinks, dirExists } from '../../../core/util/index.js';
import { safeText } from '../../../core/util/index.js';
import { assertTestWritable } from '../../../host/test-guard.js';
import type { CheckResult, Summary } from './types.js';

const two = (n: number): string => String(n).padStart(2, '0');

/** repair-20261015-093012.log */
export function logName(when: Date): string {
  return (
    'repair-' +
    when.getFullYear() +
    two(when.getMonth() + 1) +
    two(when.getDate()) +
    '-' +
    two(when.getHours()) +
    two(when.getMinutes()) +
    two(when.getSeconds()) +
    '.log'
  );
}

/** The log's text. `found` is what the first look saw; `final` what is true after the fixes (same list if none). */
export function logText(o: {
  when: Date;
  version: string;
  command: string;
  found: readonly CheckResult[];
  final: readonly CheckResult[];
  summary: Summary;
}): string {
  const lines: string[] = [
    'Repair log ' + o.when.toISOString(),
    'Version ' + o.version + ', command: ' + o.command,
    '',
    'Found:',
  ];
  for (const r of o.found)
    lines.push(
      '  [' +
        r.status +
        '] ' +
        r.group +
        ' / ' +
        r.name +
        ': ' +
        r.detail +
        (r.plan ? ' (can fix: ' + r.plan + ')' : ''),
    );
  const changed = o.final.filter((r) => r.applied || r.error);
  lines.push('', changed.length ? 'Changed:' : 'Nothing was changed.');
  for (const r of changed) {
    lines.push('  ' + r.name + ':');
    if (r.applied)
      lines.push(
        '    changed: ' + r.applied.done,
        '    before:  ' + r.applied.before,
        '    after:   ' + r.applied.after,
      );
    if (r.error) lines.push('    problem: ' + r.error);
  }
  const s = o.summary;
  lines.push(
    '',
    'Result: ' +
      s.ok +
      ' ok, ' +
      s.fixed +
      ' fixed, ' +
      s.warn +
      ' warnings, ' +
      s.needsYou +
      ' need you, ' +
      s.skipped +
      ' skipped',
    '',
  );
  return lines.join('\n');
}

/**
 * Writes the log in <storage>\logs and returns its path, or null when the storage folder does not exist (nothing to
 * keep a log in) or is not safe to write in. Text from the sandbox is cleaned first.
 */
export function writeRepairLog(storageRoot: string, text: string, when: Date): string | null {
  if (!dirExists(storageRoot)) return null;
  const dir = path.join(storageRoot, 'logs');
  const file = path.join(dir, logName(when));
  try {
    assertNoLinks(storageRoot, dir);
    assertTestWritable(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, safeText(text), 'utf8');
    return file;
  } catch {
    // A log that cannot be written must not undo or hide the repair itself; the caller says there is no log.
    return null;
  }
}
