// Does a project need PowerShell 7 (pwsh)? Windows PowerShell 5.1 ships with Windows, so a plain *.ps1 says nothing; a
// script that asks for 7 (#Requires -Version 7 / -PSEdition Core) or tells you to run it with `pwsh` does. usesPwsh is
// pure; readPwshScripts reads a bounded sample of the workspace (no links followed, files and bytes capped).
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectFile } from './databases.js';

/** Scripts looked at: the workspace root and one folder down, at most this many, only their start. */
export const PWSH_MAX_SCRIPTS = 40;
export const PWSH_MAX_BYTES = 64 * 1024;
const MAX_LINES = 400;
const MAX_LINE = 400;
const SKIP = /^(node_modules|\.git|vendor|target|bin|obj|dist|build|out|\.venv|venv|packages)$/i;

/** Why one line asks for PowerShell 7, or null. Plain string work per line (no regex that can backtrack). */
const pwshLine = (raw: string): string | null => {
  const line = raw.trimStart().slice(0, MAX_LINE).toLowerCase();
  if (line.startsWith('#requires')) {
    const words = line.slice('#requires'.length).split(/\s+/).filter(Boolean);
    const after = (flag: string): string | undefined => words[words.indexOf(flag) + 1];
    const version = words.includes('-version') ? Number.parseInt(after('-version') ?? '', 10) : NaN;
    if (version >= 7) return '#Requires -Version ' + version;
    if (words.includes('-psedition') && after('-psedition') === 'core') return '#Requires -PSEdition Core';
    return null;
  }
  // "Usage: pwsh scripts/build.ps1", "& pwsh -File x.ps1", "pwsh.exe -NoProfile ...": the word pwsh, then an option
  // or a script (so prose like "works in pwsh too" does not count).
  // At most a few occurrences per line, each looking at a short window: linear in the (capped) input.
  for (let at = line.indexOf('pwsh'), n = 0; at !== -1 && n < 4; at = line.indexOf('pwsh', at + 4), n++) {
    const end = at + (line.startsWith('pwsh.exe', at) ? 8 : 4);
    if (at > 0 && /[\w.$-]/.test(line[at - 1])) continue;
    if (line[end] !== ' ' && line[end] !== '\t') continue;
    const next =
      line
        .slice(end, end + 80)
        .trimStart()
        .split(/\s/, 1)[0] ?? '';
    if (next.startsWith('-') || next.includes('.ps1')) return 'pwsh usage';
  }
  return null;
};

/** The first script that needs PowerShell 7 and why ("moh.ps1: #Requires -Version 7"), or null. */
export function usesPwsh(files: readonly ProjectFile[]): string | null {
  for (const file of files.slice(0, PWSH_MAX_SCRIPTS)) {
    if (!/\.ps[dm]?1$/i.test(file.path)) continue;
    const lines = file.text.slice(0, PWSH_MAX_BYTES).split(/\r?\n/, MAX_LINES);
    for (const line of lines) {
      const why = pwshLine(line);
      if (why) return file.path.replace(/\\/g, '/') + ': ' + why;
    }
  }
  return null;
}

/** The start of a file, through one handle, only when that handle is a regular file. */
const readStart = (file: string): string | null => {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, PWSH_MAX_BYTES));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
};

/** *.ps1 / *.psm1 / *.psd1 in the workspace root and its direct sub-folders (root first), capped. Links are skipped. */
export function readPwshScripts(root: string): ProjectFile[] {
  const list = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).slice(0, 2000);
    } catch {
      return [];
    }
  };
  const isScript = (d: fs.Dirent): boolean => d.isFile() && /\.ps[dm]?1$/i.test(d.name);
  const top = list(root);
  const names = [
    ...top.filter(isScript).map((d) => d.name),
    ...top
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP.test(d.name))
      .slice(0, 200)
      .flatMap((d) =>
        list(path.join(root, d.name))
          .filter(isScript)
          .map((f) => d.name + '/' + f.name),
      ),
  ].slice(0, PWSH_MAX_SCRIPTS);
  return names.flatMap((name) => {
    const text = readStart(path.join(root, name));
    return text === null ? [] : [{ path: name, text }];
  });
}

/** PowerShell 7 installed on this PC (the MSI's folder, or a pwsh.exe on PATH other than a Store alias). */
export function pcHasPwsh(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): boolean {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  if (exists(path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'))) return true;
  return (env.PATH ?? env.Path ?? '')
    .split(';')
    .some((d) => d && !/WindowsApps/i.test(d) && exists(path.win32.join(d, 'pwsh.exe')));
}

/**
 * The decision for toolchains.pwsh.enabled: true/false are kept; "auto" is on when a script needs PowerShell 7, or, in
 * a folder that is no project yet (`fresh`), when this PC has it.
 */
export function decidePwsh(
  setting: boolean | 'auto',
  scripts: readonly ProjectFile[],
  fresh: boolean,
  pcHas: boolean,
): { on: boolean; reason: string } {
  if (setting !== 'auto') return { on: setting, reason: setting ? 'enabled in config' : 'disabled in config' };
  const why = usesPwsh(scripts);
  if (why) return { on: true, reason: why };
  if (fresh && pcHas) return { on: true, reason: 'installed on this PC (new folder)' };
  return { on: false, reason: 'no script needs PowerShell 7' };
}
