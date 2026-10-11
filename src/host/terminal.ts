// Windows Terminal for the sandbox window. The host downloads the portable build once into persistent storage, so
// logon.cmd can open it the moment the sandbox logs in (no PowerShell window first).
import fs from 'node:fs';
import path from 'node:path';
import { githubAsset, installArchive } from '../shared/download.js';
import { safeRemove } from '../shared/safe-remove.js';
import { z } from 'zod';
import { assertNoLinks, errMsg, fileExists, parseJsonc, writeJson } from '../core/util.js';

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

/** Our own profile id, so the profile is found again (and user edits to it are kept) on later launches. */
export const PWSH_PROFILE_GUID = '{5f3a6c1e-7d2b-4e8a-9c41-0b6d2a8f7e93}';
/** pwsh.exe as the sandbox sees it (toolchains/pwsh.ts installs it to tools\pwsh). */
const GUEST_PWSH = 'C:\\AgentData\\tools\\pwsh\\pwsh.exe';

const MAX_SETTINGS_BYTES = 1024 * 1024;
const TerminalSettings = z.looseObject({
  profiles: z.union([z.array(z.looseObject({ guid: z.string().optional() })), z.looseObject({ list: z.array(z.looseObject({ guid: z.string().optional() })).optional() })]).optional(),
});

/**
 * settings.json with the "PowerShell 7" profile shown when `visible`, else hidden (never deleted: a user's tweaks to it
 * survive turning pwsh off and on). Pure: returns null when nothing changes.
 */
export const withPwshProfile = (settings: z.output<typeof TerminalSettings>, visible: boolean): z.output<typeof TerminalSettings> | null => {
  const profiles = Array.isArray(settings.profiles) ? { list: settings.profiles } : { ...settings.profiles };
  const list = [...(profiles.list ?? [])];
  const at = list.findIndex((p) => p.guid?.toLowerCase() === PWSH_PROFILE_GUID);
  if (at === -1 && !visible) return null;
  if (at === -1) list.push({ guid: PWSH_PROFILE_GUID, name: 'PowerShell 7', commandline: '"' + GUEST_PWSH + '" -NoLogo', icon: GUEST_PWSH, hidden: false });
  else if ((list[at].hidden === true) === !visible) return null;
  else list[at] = { ...list[at], hidden: !visible };
  return { ...settings, profiles: { ...profiles, list } };
};

/**
 * Shows the PowerShell 7 profile once pwsh is installed in this data folder (and `allowed`, i.e. toolchains.pwsh is
 * not off), hides it otherwise. settings.json is written by the sandbox too: read with a size cap, through no links,
 * shape-checked, only rewritten when the profile changes; a file that does not parse is left alone.
 */
export const syncPwshProfile = (dataPath: string, allowed: boolean): void => {
  const file = path.join(terminalDir(dataPath), 'settings', 'settings.json');
  assertNoLinks(dataPath, file);
  if (!fileExists(file) || fs.statSync(file).size > MAX_SETTINGS_BYTES) return;
  const visible = allowed && fileExists(path.join(dataPath, 'tools', 'pwsh', 'pwsh.exe'));
  let parsed: z.output<typeof TerminalSettings>;
  try {
    const result = TerminalSettings.safeParse(parseJsonc<unknown>(fs.readFileSync(file, 'utf8'), file));
    if (!result.success) return;
    parsed = result.data;
  } catch { return; }
  const next = withPwshProfile(parsed, visible);
  if (next) writeJson(file, next);
};

export const ensureTerminal = async (dataPath: string, refresh: boolean, options: { pwsh?: boolean } = {}): Promise<{ exe: string | null; message: string }> => {
  const result = await installTerminal(dataPath, refresh);
  if (result.exe) {
    // The profile is a nicety: a settings problem never costs the sandbox its terminal.
    try { syncPwshProfile(dataPath, options.pwsh ?? false); } catch (e) { return { ...result, message: result.message + ' (PowerShell 7 profile not updated: ' + errMsg(e) + ')' }; }
  }
  return result;
};

const installTerminal = async (dataPath: string, refresh: boolean): Promise<{ exe: string | null; message: string }> => {
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
