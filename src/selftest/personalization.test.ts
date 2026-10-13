// Things written for Windows itself on this PC: the registry personalisation (.reg file) and the Windows Terminal
// PowerShell 7 profile. The Windows Terminal part is only tried on temp copies.
import fs from 'node:fs';
import path from 'node:path';
import { toRegFile } from '../host/profile/index.js';
import { PWSH_PROFILE_GUID, syncPwshProfile, withPwshProfile } from '../host/tools/index.js';
import type { Suite } from './support/suite.js';

interface TerminalSettings {
  theme: string;
  profiles: { list: { guid: string; hidden?: boolean; name?: string; fontSize?: number }[] };
}

export const personalizationSuite: Suite = {
  name: 'personalization',
  title: 'registry personalisation (.reg) and the Windows Terminal PowerShell 7 profile',
  run: (t) => {
    t.section('registry values');
    const reg = toRegFile([
      { key: 'Control Panel\\Desktop', name: 'WallpaperStyle', kind: 'String', value: '10' },
      { key: 'X', name: 'D', kind: 'DWord', value: 4294967295 },
      { key: 'X', name: 'B', kind: 'Binary', value: Buffer.from([1, 255]).toString('base64') },
    ]);
    t.includes(reg, '[HKEY_CURRENT_USER\\Control Panel\\Desktop]', 'the .reg file only writes under HKCU');
    t.includes(reg, '"WallpaperStyle"="10"', 'string values are written as strings');
    t.includes(reg, '"D"=dword:ffffffff', 'DWORD values are written in hex');
    t.includes(reg, '"B"=hex:01,ff', 'binary values are written as hex bytes');

    t.section('Windows Terminal profile');
    const shown = withPwshProfile({ theme: 'dark', profiles: { defaults: { font: {} } } }, true);
    const shownProfiles = shown?.profiles as { list: Record<string, unknown>[]; defaults?: unknown } | undefined;
    t.equal(shownProfiles?.list.length, 1, 'a PowerShell 7 profile is added once pwsh is installed');
    t.equal(shownProfiles?.list[0].guid, PWSH_PROFILE_GUID, 'the added profile has our GUID');
    t.includes(String(shownProfiles?.list[0].commandline), 'pwsh.exe', 'the added profile starts pwsh.exe');
    t.check(Boolean(shownProfiles?.defaults) && shown?.theme === 'dark', 'the rest of the settings are kept');
    t.equal(withPwshProfile(shown!, true), null, 'nothing is rewritten when the profile is already there');
    t.equal(
      withPwshProfile({ profiles: { defaults: {} } }, false),
      null,
      'nothing is rewritten when pwsh was never wanted',
    );

    const edited = {
      profiles: { list: [{ guid: 'other' }, { guid: PWSH_PROFILE_GUID.toUpperCase(), name: 'My pwsh', fontSize: 14 }] },
    };
    const hidden = withPwshProfile(edited, false)?.profiles as { list: Record<string, unknown>[] } | undefined;
    t.equal(
      {
        hidden: hidden?.list[1].hidden,
        name: hidden?.list[1].name,
        fontSize: hidden?.list[1].fontSize,
        count: hidden?.list.length,
      },
      { hidden: true, name: 'My pwsh', fontSize: 14, count: 2 },
      "turning pwsh off hides the profile and keeps the user's edits",
    );
    const oldForm = withPwshProfile({ profiles: [{ guid: 'a' }] }, true)?.profiles as { list: unknown[] };
    t.equal(oldForm.list.length, 2, 'the old array form of "profiles" works');

    t.section('Windows Terminal settings.json on disk (JSONC, temp copy)');
    const data = t.at('wt-data');
    const settings = t.write(
      path.join(data, 'tools', 'terminal', 'settings', 'settings.json'),
      '// edited in the sandbox\n{ "theme": "light", "profiles": { "list": [{ "guid": "{x}", }] } }',
    );
    const read = (): TerminalSettings => JSON.parse(fs.readFileSync(settings, 'utf8')) as TerminalSettings;
    syncPwshProfile(data, true);
    const untouched = fs.readFileSync(settings, 'utf8');
    t.check(
      untouched.startsWith('// edited'),
      'untouched until pwsh is installed (comments and trailing commas survive)',
    );
    t.write(path.join(data, 'tools', 'pwsh', 'pwsh.exe'), 'MZ');
    syncPwshProfile(data, true);
    const added = read();
    t.equal(added.theme, 'light', "once pwsh is installed the profile is added and the user's settings are kept");
    t.equal(
      added.profiles.list.map((p) => p.guid),
      ['{x}', PWSH_PROFILE_GUID],
      'the profile is added after the existing ones',
    );
    syncPwshProfile(data, false);
    t.equal(read().profiles.list[1].hidden, true, 'the profile is hidden when pwsh is turned off');
    t.write(settings, '{ not json');
    syncPwshProfile(data, true);
    t.equal(fs.readFileSync(settings, 'utf8'), '{ not json', 'an unreadable settings file is left alone');
  },
};
