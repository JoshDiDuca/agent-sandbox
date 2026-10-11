// VS Code for debugging inside the sandbox: the portable zip build, checksum-verified. A `data` folder next to Code.exe
// switches it to portable mode, so settings and extensions live in C:\AgentData\tools\vscode\data and persist.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchJson, installArchive } from '../../shared/download.js';
import { dryRun, exists, isWin, log, mkdirp, powershell } from '../env.js';
import { arch, tool, type ToolEnv } from './common.js';

interface Release { url: string; sha256hash: string; productVersion: string }

/** Newer builds keep their files under a commit-hash folder, so the installed version is recorded here. */
const VERSION_MARKER = '.agent-sandbox-version';

const desktopShortcut = (exe: string): void => {
  if (!isWin) return;
  const link = path.join(os.homedir(), 'Desktop', 'Visual Studio Code.lnk');
  const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
  powershell('$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + q(link) + '); $s.TargetPath = ' + q(exe) + '; $s.Arguments = ' + q('"' + (process.env.AGENT_WORKSPACE ?? '') + '"') + '; $s.Save()');
};

export const setupVscode = async (env: ToolEnv, refresh: boolean): Promise<void> => {
  const root = tool('vscode');
  const exe = path.join(root, 'Code.exe');
  if (dryRun) { log('(dry run) would provision VS Code'); return; }
  if (!exists(exe) || refresh) {
    const release = await fetchJson<Release>('https://update.code.visualstudio.com/api/update/win32-' + (arch === 'arm64' ? 'arm64' : 'x64') + '-archive/stable/latest');
    log('Downloading VS Code ' + release.productVersion + ' (~150 MB once) ...');
    // Keep settings/extensions across a refresh: move the portable data folder aside and back.
    const keep = path.join(root, 'data');
    const parked = root + '-data';
    if (exists(keep)) { fs.rmSync(parked, { recursive: true, force: true }); fs.renameSync(keep, parked); }
    await installArchive(release.url, root, { sha256: release.sha256hash, locate: 'Code.exe', fileName: 'vscode.zip' });
    if (exists(parked)) fs.renameSync(parked, keep);
    fs.writeFileSync(path.join(root, VERSION_MARKER), release.productVersion);
  }
  mkdirp(path.join(root, 'data'));
  env.prepend.push(path.join(root, 'bin'));
  desktopShortcut(exe);
  const version = exists(path.join(root, VERSION_MARKER)) ? fs.readFileSync(path.join(root, VERSION_MARKER), 'utf8').trim() : 'installed';
  env.summary.push('vscode: ' + version + ' (portable; run code . or use the desktop shortcut)');
};
