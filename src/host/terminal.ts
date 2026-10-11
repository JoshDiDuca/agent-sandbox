// Windows Terminal for the sandbox window. The host downloads the portable build once into persistent storage, so
// logon.cmd can open it the moment the sandbox logs in (no PowerShell window first).
import fs from 'node:fs';
import path from 'node:path';
import { githubAsset, installArchive } from '../shared/download.js';
import { safeRemove } from '../shared/safe-remove.js';
import { assertNoLinks, errMsg, fileExists, writeJson } from '../core/util.js';

export const terminalDir = (dataPath: string): string => path.join(dataPath, 'tools', 'terminal');
export const terminalExe = (dataPath: string): string => path.join(terminalDir(dataPath), 'WindowsTerminal.exe');

/**
 * Sandbox-friendly defaults; only written when there is no settings.json yet (first download), so edits made inside
 * the sandbox stick, also across a refresh (which keeps the settings folder).
 */
const SETTINGS = {
  $schema: 'https://aka.ms/terminal-profiles-schema',
  theme: 'dark',
  firstWindowPreference: 'defaultProfile',
  confirmCloseAllTabs: false,
  // New tabs pick up the PATH and variables the runner writes machine-wide after the window opened.
  compatibility: { reloadEnvironmentVariables: true },
  warning: { confirmCloseAllTabs: false, largePaste: false, multiLinePaste: false },
  profiles: { defaults: { font: { face: 'Cascadia Mono' }, startingDirectory: '%AGENT_WORKSPACE%',closeOnExit: 'graceful' } },
};

export const ensureTerminal = async (dataPath: string, refresh: boolean): Promise<{ exe: string | null; message: string }> => {
  const exe = terminalExe(dataPath);
  const dir = terminalDir(dataPath);
  const settings = path.join(dir, 'settings');
  // installArchive replaces tools\terminal: the portable settings folder waits here meanwhile (and goes back also when
  // the download fails). One still parked from an interrupted earlier run is the one to keep.
  const parked = path.join(dataPath, 'tools', 'terminal-settings.parked');
  assertNoLinks(dataPath, settings);
  assertNoLinks(dataPath, parked);
  if (fileExists(exe) && !refresh) return { exe, message: 'cached' };
  try {
    if (fs.existsSync(settings)) { safeRemove(parked, path.dirname(parked)); fs.renameSync(settings, parked); }
    try {
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const asset = await githubAsset('microsoft/terminal', new RegExp('^Microsoft\\.WindowsTerminal_[\\d.]+_' + arch + '\\.zip$'));
      await installArchive(asset.url, dir, { sha256: asset.sha256, locate: 'WindowsTerminal.exe', fileName: asset.name });
      fs.writeFileSync(path.join(dir, '.portable'), '');
      return { exe, message: 'downloaded ' + asset.name };
    } finally {
      if (fs.existsSync(parked)) { fs.mkdirSync(dir, { recursive: true }); safeRemove(settings, path.dirname(settings)); fs.renameSync(parked, settings); }
      const settingsFile = path.join(settings, 'settings.json');
      assertNoLinks(dataPath, settingsFile);
      if (fileExists(path.join(dir, '.portable')) && !fs.existsSync(settingsFile)) writeJson(settingsFile, SETTINGS);
    }
  } catch (e) {
    return { exe: null, message: 'download failed, the sandbox will use a plain PowerShell window (' + errMsg(e) + ')' };
  }
};
