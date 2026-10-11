// Windows Terminal for the sandbox window. The host downloads the portable build once into persistent storage, so
// logon.cmd can open it the moment the sandbox logs in (no PowerShell window first).
import fs from 'node:fs';
import path from 'node:path';
import { githubAsset, installArchive } from '../shared/download.js';
import { errMsg, fileExists, writeJson } from '../core/util.js';

export const terminalDir = (dataPath: string): string => path.join(dataPath, 'tools', 'terminal');
export const terminalExe = (dataPath: string): string => path.join(terminalDir(dataPath), 'WindowsTerminal.exe');

/** Sandbox-friendly defaults; only written if the user has no settings yet, so edits made inside the sandbox stick. */
const SETTINGS = {
  $schema: 'https://aka.ms/terminal-profiles-schema',
  theme: 'dark',
  firstWindowPreference: 'defaultProfile',
  confirmCloseAllTabs: false,
  warning: { confirmCloseAllTabs: false, largePaste: false, multiLinePaste: false },
  profiles: { defaults: { font: { face: 'Cascadia Mono' }, startingDirectory: '%AGENT_WORKSPACE%',closeOnExit: 'graceful' } },
};

export const ensureTerminal = async (dataPath: string, refresh: boolean): Promise<{ exe: string | null; message: string }> => {
  const exe = terminalExe(dataPath);
  if (fileExists(exe) && !refresh) return { exe, message: 'cached' };
  try {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const asset = await githubAsset('microsoft/terminal', new RegExp('^Microsoft\\.WindowsTerminal_[\\d.]+_' + arch + '\\.zip$'));
    await installArchive(asset.url, terminalDir(dataPath), { sha256: asset.sha256, locate: 'WindowsTerminal.exe', fileName: asset.name });
    fs.writeFileSync(path.join(terminalDir(dataPath), '.portable'), '');
    writeJson(path.join(terminalDir(dataPath), 'settings', 'settings.json'), SETTINGS);
    return { exe, message: 'downloaded ' + asset.name };
  } catch (e) {
    return { exe: null, message: 'download failed, the sandbox will use a plain PowerShell window (' + errMsg(e) + ')' };
  }
};
