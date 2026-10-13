// storage.markSandboxFiles: programs and scripts that appear or change in a project while a sandbox runs get Windows'
// "downloaded from the internet" mark (the Zone.Identifier stream, zone 3). Running one on this PC then goes through
// SmartScreen, and PowerShell's RemoteSigned policy refuses an unsigned marked script. So something an agent planted is
// not run by a double-click or a habit. Runs in the background watcher; only the mark is written, never the file.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readValid, writeJsonAtomic } from '../../shared/io/index.js';

/** What Windows runs when you open it (not source files such as .js or .py: those need a program you choose). */
export const RISKY =
  /\.(exe|dll|com|scr|pif|msi|msix|msp|appx|appxbundle|bat|cmd|ps1|psm1|psd1|vbs|vbe|wsf|wsh|hta|lnk|url|jar|reg|cpl|application|gadget|chm)$/i;
const MARK = '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:windows-development-sandbox\r\n';
/** Folders not worth watching closely (git's own files; dependency and build folders are still marked). */
const SKIP = /(^|[\\/])\.git([\\/]|$)/i;

/** Marks one file if it is a program or script (and a plain file, not a link). Returns true when it marked it. */
export const markFromSandbox = (file: string): boolean => {
  if (!RISKY.test(file) || SKIP.test(file)) return false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return false;
    fs.writeFileSync(file + ':Zone.Identifier', MARK);
    return true;
  } catch {
    return false;
  }
};

/** Has this file the mark? */
export const isMarked = (file: string): boolean => {
  try {
    return fs.readFileSync(file + ':Zone.Identifier', 'utf8').includes('ZoneId=3');
  } catch {
    return false;
  }
};

/** Watches the projects while the sandbox runs and marks what appears or changes; returns a function that stops it. */
export const watchAndMark = (projects: string[], note: (message: string) => void = () => undefined): (() => void) => {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    timer = undefined;
    const marked = [...pending].filter(markFromSandbox);
    pending.clear();
    if (marked.length)
      note(
        'marked as from the sandbox (SmartScreen asks before they run here): ' +
          marked
            .slice(0, 10)
            .map((f) => path.basename(f))
            .join(', ') +
          (marked.length > 10 ? ' and ' + (marked.length - 10) + ' more' : ''),
      );
  };
  const watchers = projects.flatMap((project) => {
    try {
      return [
        fs.watch(project, { recursive: true }, (_event, file) => {
          const rel = file ? String(file) : '';
          if (!rel || !RISKY.test(rel) || SKIP.test(rel)) return;
          pending.add(path.join(project, rel));
          timer ??= setTimeout(flush, 1000);
        }),
      ];
    } catch {
      return [];
    }
  });
  return () => {
    watchers.forEach((w) => w.close());
    clearTimeout(timer);
    if (pending.size) flush();
  };
};

// ---- what the watcher marks, and the size of the persisted data (host-only files next to the sync state) ----------

const marksFile = (storageRoot: string, dataPath: string): string =>
  path.join(storageRoot, 'sync', path.basename(dataPath) + '-mark.json');
const sizeFile = (storageRoot: string, dataPath: string): string =>
  path.join(storageRoot, 'sync', path.basename(dataPath) + '-size.json');

/** The projects to watch and mark (empty: storage.markSandboxFiles is off). */
export const saveMarkedProjects = (storageRoot: string, dataPath: string, projects: string[]): void =>
  writeJsonAtomic(marksFile(storageRoot, dataPath), projects);
export const readMarkedProjects = (storageRoot: string, dataPath: string): string[] =>
  readValid(z.array(z.string().max(1024)).max(64), marksFile(storageRoot, dataPath)) ?? [];

/** The data folder's size, measured by the watcher when a sandbox closes (measuring at launch would be slow). */
export const saveDataSize = (storageRoot: string, dataPath: string, bytes: number): void =>
  writeJsonAtomic(sizeFile(storageRoot, dataPath), { bytes, at: new Date().toISOString() });
export const readDataSize = (storageRoot: string, dataPath: string): { bytes: number; at: string } | null =>
  readValid(z.object({ bytes: z.number().min(0), at: z.string().max(40) }), sizeFile(storageRoot, dataPath));
