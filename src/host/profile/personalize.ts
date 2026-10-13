// Captures the look of this desktop (theme, accent colour, taskbar, Explorer options, wallpaper, mouse/keyboard,
// regional formats) from HKCU as a .reg file the sandbox imports at logon. Only an allow-list of values is read.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, errMsg, fileExists, isWin, runPowerShell } from '../../core/util/index.js';
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

function captureScript(spec: Readonly<Record<string, readonly string[]>>): string {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    "$spec = '" + JSON.stringify(spec).replace(/'/g, "''") + "' | ConvertFrom-Json",
    '$out = @()',
    'foreach ($p in $spec.PSObject.Properties) {',
    '  $key = Get-Item -LiteralPath ("HKCU:\\" + $p.Name)',
    '  if (-not $key) { continue }',
    '  foreach ($name in $p.Value) {',
    '    $raw = $key.GetValue($name, $null, "DoNotExpandEnvironmentNames")',
    '    if ($null -eq $raw) { continue }',
    '    $kind = $key.GetValueKind($name).ToString()',
    '    if ($kind -eq "Binary") { $raw = [Convert]::ToBase64String([byte[]]$raw) }',
    '    $out += [pscustomobject]@{ key = $p.Name; name = $name; kind = $kind; value = $raw }',
    '  }',
    '}',
    '$wall = (Get-ItemProperty -LiteralPath "HKCU:\\Control Panel\\Desktop").WallPaper',
    '[pscustomobject]@{ values = $out; wallpaper = $wall } | ConvertTo-Json -Depth 5 -Compress',
  ].join('\n');
}

/** Writes personalize.reg (+ the wallpaper image) into `<launch>\personalize`. Returns a short summary. */
export function capturePersonalization(launchPath: string): string {
  if (!isWin) return 'skipped (not Windows)';
  try {
    const { status, stdout } = runPowerShell(captureScript(VALUES), true);
    if (status !== 0) return 'skipped (registry read failed)';
    // runPowerShell has PowerShell write UTF-8 (non-ASCII date formats and wallpaper paths survive); a BOM is allowed.
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
