// The crash report: what Windows logged when the sandbox ended and the last minutes of the sandbox's memory log, kept
// in <storage>\logs\crashes (the newest 20).
import fs from 'node:fs';
import path from 'node:path';
import { assertNoLinks, safeText } from '../../core/util/index.js';
import { hostDataFolder, hostDataRoot } from '../storage/index.js';
import { explainStop, readStopEvents, type StopCause, type StopEvent } from './stop-events.js';

const KEEP_REPORTS = 20;
const MEMORY_TAIL_BYTES = 16 * 1024;

function crashDir(storageRoot: string): string {
  return path.join(storageRoot, 'logs', 'crashes');
}

/**
 * The report text (pure): what happened (the sandbox's or this PC's stop code, where the dump is) and the memory log's
 * last lines. `memoryLog` is the sandbox's own file, so it is shown through safeText.
 */
export function crashReportText(
  cause: StopCause,
  events: readonly StopEvent[],
  memoryLog: string,
  lastSeen: string,
): string {
  const eventLines = events.length
    ? events.map(
        (e) => '  ' + e.at + '  ' + e.provider + ' ' + e.id + (e.process ? ': ' + e.process.replace(/\s+/g, ' ') : ''),
      )
    : ['  (none)'];
  const memoryLines = memoryLog
    ? memoryLog
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-30)
        .map((l) => '  ' + safeText(l))
    : ['  (none found)'];
  return [
    'Sandbox crash report, written ' + new Date().toISOString(),
    'What happened: ' + cause.text + ' at ' + cause.at + ' (the sandbox was last seen running at ' + lastSeen + ').',
    '',
    'Windows events around then:',
    ...eventLines,
    '',
    "The sandbox's memory log, last lines (C:\\AgentData\\logs\\memory-*.log inside it):",
    ...memoryLines,
    '',
  ].join('\n');
}

/** The newest memory log the sandbox wrote, last 16 KB at most, without following links in the data folder. */
function memoryLogTail(dataPath: string): string {
  try {
    const logs = hostDataFolder(dataPath, 'logs');
    assertNoLinks(hostDataRoot(dataPath), logs);
    const newest = fs
      .readdirSync(logs)
      .filter((f) => /^memory-\d{8}-\d{6}\.log$/.test(f))
      .sort()
      .pop();
    if (!newest) return '';
    const file = path.join(logs, newest);
    if (!fs.lstatSync(file).isFile()) return '';
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(size, MEMORY_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * When the sandbox ended in a crash (its own, this PC's, power, low memory): writes the report and returns its path.
 */
export function saveCrashReport(storageRoot: string, dataPath: string, lastSeen: string): string | null {
  const events = readStopEvents(new Date(Date.parse(lastSeen) - 2 * 60 * 1000), storageRoot);
  const cause = explainStop(events);
  if (!cause || !['sandboxCrash', 'crash', 'memory'].includes(cause.kind)) return null;
  const dir = crashDir(storageRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'crash-' + cause.at.replace(/[:.]/g, '-') + '.txt');
  fs.writeFileSync(file, crashReportText(cause, events, memoryLogTail(dataPath), lastSeen));
  for (const old of fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('crash-'))
    .sort()
    .slice(0, -KEEP_REPORTS))
    fs.rmSync(path.join(dir, old), { force: true });
  return file;
}
