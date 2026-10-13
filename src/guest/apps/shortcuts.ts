import os from 'node:os';
import path from 'node:path';
import { powershell } from '../runtime/process.js';

/** Desktop and Start menu shortcuts, all in one PowerShell call. */
export const shortcuts = (apps: { name: string; exe: string }[]): void => {
  if (!apps.length) return;
  const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
  const desktop = path.join(os.homedir(), 'Desktop');
  const start = path.join(
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Sandbox apps',
  );
  const lines = [
    '$w = New-Object -ComObject WScript.Shell',
    'New-Item -ItemType Directory -Force -Path ' + q(start) + ' | Out-Null',
  ];
  for (const app of apps) {
    for (const folder of [desktop, start]) {
      const name = app.name.replace(/[\\/:*?"<>|]/g, '');
      lines.push(
        '$s = $w.CreateShortcut(' +
          q(path.join(folder, name + '.lnk')) +
          '); $s.TargetPath = ' +
          q(app.exe) +
          '; $s.WorkingDirectory = ' +
          q(path.dirname(app.exe)) +
          '; $s.Save()',
      );
    }
  }
  powershell(lines.join('\n'));
};
