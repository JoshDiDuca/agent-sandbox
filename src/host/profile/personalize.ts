// Captures the look of this desktop (theme, accent colour, taskbar, Explorer options, wallpaper, mouse/keyboard,
// regional formats) from HKCU as a .reg file the sandbox imports at logon. Only an allow-list of values is read.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, errMsg, fileExists, isWin, runPowerShell } from '../../core/util/index.js';

const VALUES: Record<string, string[]> = {
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
};

export interface RegValue {
  key: string;
  name: string;
  kind: string;
  value: string | number | string[];
}

const toHex = (bytes: Buffer): string => [...bytes].map((b: number) => b.toString(16).padStart(2, '0')).join(',');
const regString = (s: string): string => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** Formats captured values as a .reg file (UTF-16 friendly text; written as UTF-16LE with BOM). */
export const toRegFile = (values: RegValue[]): string => {
  const byKey = new Map<string, RegValue[]>();
  for (const v of values) byKey.set(v.key, [...(byKey.get(v.key) ?? []), v]);
  const lines = ['Windows Registry Editor Version 5.00', ''];
  for (const [key, list] of byKey) {
    lines.push('[HKEY_CURRENT_USER\\' + key + ']');
    for (const v of list) {
      const name = regString(v.name);
      switch (v.kind) {
        case 'DWord':
          lines.push(name + '=dword:' + (Number(v.value) >>> 0).toString(16).padStart(8, '0'));
          break;
        case 'QWord':
          lines.push(
            name +
              '=hex(b):' +
              toHex(
                Buffer.from(
                  BigInt.asUintN(64, BigInt(v.value as number))
                    .toString(16)
                    .padStart(16, '0'),
                  'hex',
                ).reverse(),
              ),
          );
          break;
        case 'Binary':
          lines.push(name + '=hex:' + toHex(Buffer.from(String(v.value), 'base64')));
          break;
        case 'ExpandString':
          lines.push(name + '=hex(2):' + toHex(Buffer.from(String(v.value) + '\0', 'utf16le')));
          break;
        case 'MultiString':
          lines.push(name + '=hex(7):' + toHex(Buffer.from((v.value as string[]).join('\0') + '\0\0', 'utf16le')));
          break;
        default:
          lines.push(name + '=' + regString(String(v.value)));
      }
    }
    lines.push('');
  }
  return lines.join('\r\n');
};

const CAPTURE_SCRIPT = (spec: Record<string, string[]>): string =>
  [
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

/** Writes personalize.reg (+ the wallpaper image) into `<launch>\personalize`. Returns a short summary. */
export const capturePersonalization = (launchPath: string): string => {
  if (!isWin) return 'skipped (not Windows)';
  try {
    const { status, stdout } = runPowerShell(CAPTURE_SCRIPT(VALUES), true);
    if (status !== 0) return 'skipped (registry read failed)';
    // runPowerShell has PowerShell write UTF-8 (non-ASCII date formats and wallpaper paths survive); a BOM is tolerated.
    const parsed = JSON.parse(stdout.replace(/^﻿/, '').trim()) as {
      values: RegValue[] | RegValue | null;
      wallpaper?: string;
    };
    const values = parsed.values === null ? [] : Array.isArray(parsed.values) ? parsed.values : [parsed.values];
    const dir = path.join(launchPath, 'personalize');
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'personalize.reg'), '﻿' + toRegFile(values), 'utf16le');
    const wallpaper = parsed.wallpaper ?? '';
    const themesCopy = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
    const source = fileExists(wallpaper) ? wallpaper : fileExists(themesCopy) ? themesCopy : null;
    if (source) fs.copyFileSync(source, path.join(dir, 'wallpaper' + (path.extname(source) || '.jpg')));
    return values.length + ' settings' + (source ? ' + wallpaper' : '');
  } catch (e) {
    return 'skipped (' + errMsg(e) + ')';
  }
};
