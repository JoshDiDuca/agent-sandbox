// Captures the look of this desktop (theme, accent colour, taskbar, Explorer options, wallpaper, mouse/keyboard,
// regional formats) from HKCU as a .reg file the sandbox imports at logon. Only an allow-list of values is read.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ensureDir, errMsg, fileExists, isWin } from '../../core/util/index.js';
import { SYSTEM } from '../../shared/system.js';
import { nativeScript } from '../native.js';
import { toRegFile, type RegValue } from './reg-file.js';

/** The HKCU values captured, by key. */
const VALUES = {
  'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize': [
    'AppsUseLightTheme',
    'SystemUsesLightTheme',
    'EnableTransparency',
    'ColorPrevalence',
  ],
  'Software\\Microsoft\\Windows\\DWM': [
    'AccentColor',
    'AccentColorInactive',
    'ColorizationColor',
    'ColorizationAfterglow',
    'ColorizationColorBalance',
    'ColorPrevalence',
    'EnableWindowColorization',
  ],
  'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent': [
    'AccentPalette',
    'AccentColorMenu',
    'StartColorMenu',
  ],
  'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced': [
    'TaskbarAl',
    'TaskbarSi',
    'TaskbarDa',
    'TaskbarMn',
    'TaskbarGlomLevel',
    'ShowTaskViewButton',
    'Hidden',
    'HideFileExt',
    'ShowSuperHidden',
    'LaunchTo',
    'NavPaneExpandToCurrentFolder',
    'NavPaneShowAllFolders',
    'ShowCopilotButton',
    'Start_TrackDocs',
    'Start_Layout',
  ],
  'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StuckRects3': ['Settings'],
  'Software\\Microsoft\\Windows\\CurrentVersion\\Search': ['SearchboxTaskbarMode'],
  'Control Panel\\Desktop': [
    'WallpaperStyle',
    'TileWallpaper',
    'MenuShowDelay',
    'CursorBlinkRate',
    'DragFullWindows',
    'FontSmoothing',
    'FontSmoothingType',
    'UserPreferencesMask',
  ],
  'Control Panel\\Colors': ['Background', 'Hilight', 'HotTrackingColor'],
  'Control Panel\\Mouse': [
    'MouseSpeed',
    'MouseSensitivity',
    'MouseThreshold1',
    'MouseThreshold2',
    'DoubleClickSpeed',
    'SwapMouseButtons',
  ],
  'Control Panel\\Keyboard': ['KeyboardDelay', 'KeyboardSpeed'],
  'Control Panel\\International': [
    'sShortDate',
    'sLongDate',
    'sShortTime',
    'sTimeFormat',
    'iFirstDayOfWeek',
    'sDecimal',
    'sThousand',
    'sList',
    'iMeasure',
    'iTime',
    'iTLZero',
  ],
  'Control Panel\\Accessibility\\StickyKeys': ['Flags'],
} as const satisfies Record<string, readonly string[]>;

/** native\scripts\capture-look.ps1 with the spec in a temp file: the values found and the wallpaper path, as JSON. */
function readLook(spec: Readonly<Record<string, readonly string[]>>): { status: number; stdout: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-look-'));
  try {
    const file = path.join(dir, 'spec.json');
    fs.writeFileSync(file, JSON.stringify(spec), 'utf8');
    const result = spawnSync(SYSTEM.powershell(), nativeScript('capture-look.ps1', ['-SpecFile', file]), {
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return { status: result.status ?? 1, stdout: result.stdout ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes personalize.reg (+ the wallpaper image) into `<launch>\personalize`. Returns a short summary. */
export function capturePersonalization(launchPath: string): string {
  if (!isWin) return 'skipped (not Windows)';
  try {
    const { status, stdout } = readLook(VALUES);
    if (status !== 0) return 'skipped (registry read failed)';
    // The script writes UTF-8 (non-ASCII date formats and wallpaper paths survive); a BOM is allowed.
    const parsed = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as {
      values: RegValue[] | RegValue | null;
      wallpaper?: string;
    };
    const values = parsed.values === null ? [] : Array.isArray(parsed.values) ? parsed.values : [parsed.values];
    const dir = path.join(launchPath, 'personalize');
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'personalize.reg'), '\uFEFF' + toRegFile(values), 'utf16le');
    const wallpaper = parsed.wallpaper ?? '';
    const themesCopy = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
    const source = fileExists(wallpaper) ? wallpaper : fileExists(themesCopy) ? themesCopy : null;
    if (source) fs.copyFileSync(source, path.join(dir, 'wallpaper' + (path.extname(source) || '.jpg')));
    return values.length + ' settings' + (source ? ' + wallpaper' : '');
  } catch (e) {
    return 'skipped (' + errMsg(e) + ')';
  }
}
