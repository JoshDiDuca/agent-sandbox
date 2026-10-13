// The last commands run (menu or typed), kept in ~/.agent-sandbox/history.json so the menu can offer them again.
import path from 'node:path';
import { z } from 'zod';
import { userDir } from '../core/config/index.js';
import { JsonFile } from '../shared/io/index.js';

const HistorySchema = z.array(z.strictObject({ argv: z.array(z.string()).max(200), at: z.string() })).max(20);
type History = z.output<typeof HistorySchema>;
function historyFile(): JsonFile<History> {
  return new JsonFile(HistorySchema, path.join(userDir(), 'history.json'));
}
const HIDDEN = new Set(['menu', '_watch', 'self-test']);

export function readHistory(): History {
  return historyFile().read() ?? [];
}

/** Remembers a command (menu or typed) so the menu can offer it again. Never fails the command itself. */
export function recordHistory(argv: string[]): void {
  if (!argv.length || HIDDEN.has(argv[0]) || argv.includes('--help')) return;
  try {
    historyFile().write(
      [
        { argv, at: new Date().toISOString() },
        ...readHistory().filter((h) => h.argv.join('\0') !== argv.join('\0')),
      ].slice(0, 10),
    );
  } catch {
    /* history is a convenience */
  }
}

/** argv as you would type it (quoted where needed). */
export function commandLine(argv: string[]): string {
  return ['sandbox', ...argv]
    .map((a) => (/[\s"]/.test(a) || a === '' ? '"' + a.replace(/"/g, '\\"') + '"' : a))
    .join(' ');
}
