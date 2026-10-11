// Small pure helpers: version picking, .reg generation, firewall maths, storage cleanup.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { pruneStorage } from '../host/cleanup.js';
import { toRegFile } from '../host/personalize.js';
import { javaMajorFrom, pickGoRelease, pickNodeVersion, pickPackageVersion, pickSpreadVersions, projectUses, specFromVersionFile } from '../guest/toolchains/versions.js';
import { parseReleaseTags } from '../shared/download.js';
import { buildFirewallCommands, cidrToRange, ipv4DnsServers, parseDefaultGateways, parseDnsServers, subtractIps } from '../shared/netrules.js';
import { ensureDir, isWin } from '../core/util.js';
import { decidePwsh, pcHasPwsh, PWSH_MAX_BYTES, readPwshScripts, usesPwsh } from '../core/detect-pwsh.js';
import { binstallAsset, CLI_TOOLS, decideCli, pwshAsset, type CliSettings } from '../guest/toolchains/catalogue.js';
import { PWSH_PROFILE_GUID, syncPwshProfile, withPwshProfile } from '../host/terminal.js';
import type { Harness } from './harness.js';

export const helperTests = (t: Harness): void => {
  const { check, write } = t;

  t.section('versions, registry, firewall');
  const releases = [{ version: 'v23.1.0', lts: false as const }, { version: 'v22.11.0', lts: 'Jod' }, { version: 'v20.18.0', lts: 'Iron' }, { version: 'v20.9.0', lts: 'Iron' }];
  check(pickNodeVersion(releases, 'lts/*') === '22.11.0' && pickNodeVersion(releases, 'lts/iron') === '20.18.0' && pickNodeVersion(releases, '20') === '20.18.0' && pickNodeVersion(releases, 'v20.9.0') === '20.9.0' && pickNodeVersion(releases, 'node') === '23.1.0' && pickNodeVersion(releases, '99') === null, '.nvmrc specs resolve (lts/*, lts/<name>, major, exact, node)');
  const spread = pickSpreadVersions(['16.20.2', '18.19.0', '18.20.4', '20.18.0', '22.3.0', '22.11.0', '23.1.0', 'notes'], '22.11.0', 3);
  check(JSON.stringify(spread) === '["22.11.0","16.20.2","23.1.0"]' && pickSpreadVersions(['20.18.0'], '22.3.0', 3).join() === '22.3.0,20.18.0' && pickSpreadVersions(['18.20.4', '20.18.0'], '22.3.0', 1).join() === '22.3.0', 'host nvm versions: capped, current first, rest spread across other majors');
  const go = [{ version: 'go1.24rc1', stable: false, files: [] }, { version: 'go1.23.2', stable: true, files: [] }, { version: 'go1.23.1', stable: true, files: [] }, { version: 'go1.22.8', stable: true, files: [] }];
  check(pickGoRelease(go, 'stable')?.version === 'go1.23.2' && pickGoRelease(go, '1.22')?.version === 'go1.22.8' && pickGoRelease(go, 'go1.23.1')?.version === 'go1.23.1' && pickGoRelease(go, '1.30') === null, 'Go versions resolve (stable, minor prefix, exact; release candidates skipped)');
  check(javaMajorFrom('21\n') === '21' && javaMajorFrom('17.0.9') === '17' && javaMajorFrom('1.8') === '8' && javaMajorFrom('temurin-21.0.2') === '21' && javaMajorFrom('# sdkman\njava=21.0.2-tem\n', true) === '21' && specFromVersionFile('ruby-3.3.1\n') === '3.3.1', 'version files: .java-version, .sdkmanrc, .ruby-version');
  check(projectUses(['README.md', 'server/go.mod'], ['go.mod']) && projectUses(['App.csproj'], ['*.csproj']) && !projectUses(['notes.txt', 'docs/readme.md'], ['go.mod', '*.csproj']), 'enabled "auto": a language is used when its marker file is in the workspace or one folder down');
  check(pickPackageVersion(['3.9.13', '3.12.7', '3.12.10', '3.13.0-rc1', '3.13.1'], '3') === '3.13.1' && pickPackageVersion(['3.12.7', '3.12.10'], '3.12') === '3.12.10' && pickPackageVersion(['2.7.18'], '2.7') === '2.7.18', 'Python versions resolve to the newest stable match');
  const reg = toRegFile([{ key: 'Control Panel\\Desktop', name: 'WallpaperStyle', kind: 'String', value: '10' }, { key: 'X', name: 'D', kind: 'DWord', value: 4294967295 }, { key: 'X', name: 'B', kind: 'Binary', value: Buffer.from([1, 255]).toString('base64') }]);
  check(reg.includes('[HKEY_CURRENT_USER\\Control Panel\\Desktop]') && reg.includes('"WallpaperStyle"="10"') && reg.includes('"D"=dword:ffffffff') && reg.includes('"B"=hex:01,ff'), 'personalisation: registry values become a valid .reg file (HKCU only)');
  const [s172, e172] = cidrToRange('172.16.0.0/12');
  const gw = 172 * 16777216 + 28 * 65536 + 1;
  check(subtractIps([[s172, e172]], ['172.28.0.1']).every(([s, e]) => gw < s || gw > e) && !buildFirewallCommands(['8.8.8.8']).join().includes('8.8.8.8'), 'firewall maths: private block minus the gateway; public addresses ignored');
  check(parseDefaultGateways('  0.0.0.0          0.0.0.0     172.28.80.1   172.28.85.200     5\n').join() === '172.28.80.1' && parseDnsServers('   DNS Servers . . . : 172.28.80.1\n                       8.8.8.8\n   NetBIOS : x\n').join() === '172.28.80.1,8.8.8.8', 'parses gateway and DNS servers');

  check(ipv4DnsServers(['172.28.80.1', '8.8.8.8:1053', '[::1]:53', 'fe80::1']).join() === '172.28.80.1,8.8.8.8', 'DNS servers from the resolver (any Windows language): IPv4 only, ports dropped');
  check(parseReleaseTags('<a href="/coreybutler/nvm-windows/releases/tag/1.2.2">x</a><a href="/coreybutler/nvm-windows/releases/tag/1.2.2">y</a><a href="/other/repo/releases/tag/9">z</a><a href="/coreybutler/nvm-windows/releases/tag/1.1.12">w</a>', 'coreybutler/nvm-windows').join() === '1.2.2,1.1.12', 'GitHub release list page: this repo\'s tags in order, once each');

  t.section('cmd quoting (npm agents)');
  // ptyhost.ts loads env.ts, which reads session.json: import it in a child with a throwaway launch/data folder.
  const quoteDir = path.join(t.temp, 'quote');
  write(path.join(quoteDir, 'launch', 'session.json'), '{}');
  const agentCmd = write(path.join(quoteDir, 'agent.cmd'), '@"' + process.execPath + '" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n');
  // Odd quote counts flip cmd's quote state for every later argument: those come after them on purpose.
  const tricky = ['https://x?a=1&b=2', '50% off', 'a|b<c>d', 'x^y', 'say "hi" & go', 'plain', '%PATH%', 'a"b&c', 'q"x|y^z"w', 'e"5%', 'k&v', '100%'];
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', [
    'const m = await import(process.argv[1]); const [cmd, tricky] = JSON.parse(process.argv[2]);',
    'console.log(JSON.stringify({ normal: m.commandLine("C:\\\\W\\\\cmd.exe", ["/d", "/c", "C:\\\\a\\\\agent.cmd", "--model", "big one", "plain", ""]), direct: m.commandLine("C:\\\\a\\\\agent.exe", ["a&b", "50%"]),',
    '  url: m.cmdArgs(["https://x?a=1&b=2"]), pct: m.cmdArgs(["50%"]), live: m.commandLine("cmd.exe", ["/d", "/c", cmd, ...tricky]).slice(8) }));',
  ].join('\n'), pathToFileURL(path.join(t.packageRoot, 'dist', 'guest', 'ptyhost.js')).href, JSON.stringify([agentCmd, tricky])], {
    encoding: 'utf8', env: { ...process.env, AGENT_LAUNCH_DIR: path.join(quoteDir, 'launch'), AGENT_DATA_DIR: path.join(quoteDir, 'data') },
  });
  const quoting = ((): Record<string, string> => { try { return JSON.parse(probe.stdout) as Record<string, string>; } catch { return {}; } })();
  check(quoting.normal === 'C:\\W\\cmd.exe /d /c C:\\a\\agent.cmd --model "big one" plain ""' && quoting.direct === 'C:\\a\\agent.exe a&b 50%', 'command lines: ordinary arguments quoted as before; a program started directly gets & and % unchanged' + (quoting.normal ? '' : ' (' + (probe.stderr || probe.stdout).trim().slice(0, 300) + ')'));
  check(quoting.url === '"https://x?a=1&b=2"' && quoting.pct === '"50"%""', 'cmd /c arguments: & | < > ^ quoted, % split out so no %name% expands');
  // (Agents live under C:\AgentData\tools; a temp folder with spaces would also need cmd's quote rules, so skip there.)
  if (isWin && quoting.live && !/\s/.test(agentCmd)) {
    const echoed = spawnSync(process.env.ComSpec ?? 'cmd.exe', [quoting.live], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true });
    check(echoed.stdout.trim() === JSON.stringify(tricky), 'cmd /d /c <agent>.cmd passes &, |, <, >, ^, % and quotes through to the agent unchanged (got ' + echoed.stdout.trim() + ')');
  }

  t.section('cleanup');
  const store = path.join(t.temp, 'prune');
  const aged = (p: string, days: number): void => { const d = new Date(Date.now() - days * 86400000); fs.utimesSync(p, d, d); };
  for (const [name, days] of [['old', 9], ['kept', 30], ['new', 1]] as const) { aged(write(path.join(store, 'launches', name, 'agent.wsb'), 'x'), days); aged(path.join(store, 'launches', name), days); }
  aged(write(path.join(store, 'data', 'd', 'logs', 'guest-old.log'), 'x'), 20);
  write(path.join(store, 'data', 'd', 'logs', 'guest-new.log'), 'x');
  ensureDir(path.join(store, 'data', 'd', 'tools', 'git.staging-ab12'));
  aged(path.join(store, 'data', 'd', 'tools', 'git.staging-ab12'), 2);
  ensureDir(path.join(store, 'data', 'd', 'tools', 'node'));
  const pruned = pruneStorage(store, { keep: ['kept'] });
  const left = (p: string): boolean => fs.existsSync(path.join(store, p));
  check(pruned.launches === 1 && !left('launches/old') && left('launches/kept') && left('launches/new') && !left('data/d/logs/guest-old.log') && left('data/d/logs/guest-new.log') && !left('data/d/tools/git.staging-ab12') && left('data/d/tools/node'), 'cleanup: launches > 7 days, logs > 14 days and interrupted downloads go; the running launch and real tools stay');

  t.section('PowerShell 7, CLI catalogue, cargo-binstall');
  const pwshNames = ['PowerShell-7.6.6-win-x64.zip', 'PowerShell-7.6.6-win-arm64.zip', 'PowerShell-7.6.6-win-x64.msi', 'PowerShell-7.6.6-win-fxdependent.zip', 'PowerShell-7.6.6-win-x86.zip', 'PowerShell-7.6.6-win-x64.zip.sha256'];
  check(pwshNames.filter((n) => pwshAsset('x64').test(n)).join() === 'PowerShell-7.6.6-win-x64.zip' && pwshNames.filter((n) => pwshAsset('arm64').test(n)).join() === 'PowerShell-7.6.6-win-arm64.zip', 'PowerShell 7: the portable zip for the architecture (no MSI, fxdependent or x86 build)');
  const binstallNames = ['cargo-binstall-x86_64-pc-windows-msvc.zip', 'cargo-binstall-x86_64-pc-windows-msvc.full.zip', 'cargo-binstall-x86_64-pc-windows-msvc.zip.sig', 'cargo-binstall-aarch64-pc-windows-msvc.zip', 'cargo-binstall-x86_64-unknown-linux-musl.tgz'];
  check(binstallNames.filter((n) => binstallAsset('x64').test(n)).join() === 'cargo-binstall-x86_64-pc-windows-msvc.zip' && binstallNames.filter((n) => binstallAsset('arm64').test(n)).join() === 'cargo-binstall-aarch64-pc-windows-msvc.zip', 'cargo-binstall: the plain Windows zip for the architecture (not .full, not the signature)');
  const cliAsset = (name: string, arch: 'x64' | 'arm64', names: string[]): string => names.filter((n) => CLI_TOOLS.find((c) => c.name === name)!.asset(arch).test(n)).join();
  const ghNames = ['gh_2.102.0_windows_amd64.zip', 'gh_2.102.0_windows_amd64.msi', 'gh_2.102.0_windows_386.zip', 'gh_2.102.0_windows_arm64.zip', 'gh_2.102.0_linux_amd64.tar.gz'];
  const zstdNames = ['zstd-v1.5.7-win64.zip', 'zstd-v1.5.7-win32.zip', 'zstd-v1.5.7.tar.gz'];
  check(cliAsset('gh', 'x64', ghNames) === 'gh_2.102.0_windows_amd64.zip' && cliAsset('gh', 'arm64', ghNames) === 'gh_2.102.0_windows_arm64.zip' && cliAsset('zstd', 'x64', zstdNames) === 'zstd-v1.5.7-win64.zip' && cliAsset('zstd', 'arm64', zstdNames) === 'zstd-v1.5.7-win64.zip' && CLI_TOOLS.every((c) => c.exe.endsWith('.exe')), 'CLI catalogue: gh and zstd release zips per architecture (zstd: win64 also on Arm)');
  const cli = (settings: CliSettings, gitAccess: 'full' | 'readonly' | 'none', hasGithubDir = false): string => Object.entries(decideCli(settings, { gitAccess, hasGithubDir })).filter(([, d]) => d.on).map(([n]) => n).join();
  check(cli({ gh: true, zstd: true, openssl: true }, 'full') === 'gh,zstd,openssl' && cli({ gh: true, zstd: true }, 'readonly') === 'zstd' && cli({ gh: 'auto' }, 'none', true) === '' && decideCli({ gh: true }, { gitAccess: 'readonly', hasGithubDir: false }).gh.reason.includes('"full"'), 'CLI catalogue: gh only with git access "full" (it pushes through the API), whatever the config says');
  check(cli({ gh: 'auto', zstd: 'auto', openssl: 'auto' }, 'full', true) === 'gh,openssl' && cli({ gh: 'auto', zstd: 'auto' }, 'full', false) === '' && cli({}, 'full', true) === '', 'CLI catalogue: "auto" = gh with a .github folder, openssl always (a shim), zstd only when listed; unlisted tools stay off');

  const ps = (text: string, file = 'moh.ps1'): string | null => usesPwsh([{ path: file, text }]);
  check(ps('#Requires -Version 7.2\nparam()') === 'moh.ps1: #Requires -Version 7' && ps('  #requires -PSEdition Core') !== null && ps('#Requires -Modules Pester -Version 7') !== null && ps('<#\n.SYNOPSIS\n  Usage: pwsh scripts/moh/build-openmohaa.ps1 -Release\n#>') !== null && ps('& pwsh.exe -NoProfile -File x.ps1') !== null && ps('C:\\Program Files\\PowerShell\\7\\pwsh.exe -c 1') !== null, 'pwsh markers: #Requires -Version 7+ / -PSEdition Core, and pwsh usage lines');
  check(ps('#Requires -Version 5.1') === null && ps('#Requires -PSEdition Desktop') === null && ps('# Works in Windows PowerShell and pwsh too.') === null && ps('$pwsh -x; Write-Host mypwsh -y') === null && ps('#Requires -Version 7', 'notes.txt') === null && ps('Write-Host hi') === null, 'pwsh markers: Windows PowerShell scripts, prose, variables and non-scripts do not count');
  const evilStart = Date.now();
  const evilText = (' #requires' + ' -version'.repeat(5000) + '\n' + 'xpwsh pwsh\t\t'.repeat(20000) + '\n' + ' '.repeat(100000) + 'pwsh\n' + 'pwsh\n'.repeat(50000)).repeat(3);
  const evil = usesPwsh(Array.from({ length: 100 }, (_, i) => ({ path: 'a' + i + '.ps1', text: evilText })));
  check(evil === null && Date.now() - evilStart < 2000, 'pwsh markers: hostile scripts (huge lines, endless repeats) are capped and scanned in linear time (' + (Date.now() - evilStart) + ' ms)');
  check(decidePwsh('auto', [], true, true).on && !decidePwsh('auto', [], false, true).on && !decidePwsh('auto', [], true, false).on && decidePwsh('auto', [{ path: 'x/run.ps1', text: '#Requires -PSEdition Core' }], false, false).reason === 'x/run.ps1: #Requires -PSEdition Core' && !decidePwsh(false, [{ path: 'a.ps1', text: '#Requires -Version 7' }], true, true).on && decidePwsh(true, [], false, false).on, 'pwsh "auto": a script that needs it, else this PC has it (new folder only); true/false win');
  const pf = 'C:\\PF';
  check(pcHasPwsh({ ProgramFiles: pf }, (p) => p === 'C:\\PF\\PowerShell\\7\\pwsh.exe') && pcHasPwsh({ PATH: 'C:\\x;C:\\tools\\pwsh' }, (p) => p === 'C:\\tools\\pwsh\\pwsh.exe') && !pcHasPwsh({ ProgramFiles: pf, PATH: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps' }, (p) => /WindowsApps/.test(p)), 'pwsh on this PC: Program Files\\PowerShell\\7 or PATH, not a Store alias');
  const psRoot = path.join(t.temp, 'pwsh-scan');
  write(path.join(psRoot, 'moh.ps1'), '#Requires -Version 7\n');
  write(path.join(psRoot, 'scripts', 'build.ps1'), 'x'.repeat(200000) + '\n#Requires -Version 7');
  write(path.join(psRoot, 'node_modules', 'pkg.ps1'), '#Requires -Version 7');
  write(path.join(psRoot, 'scripts', 'deep', 'far.ps1'), '#Requires -Version 7');
  write(path.join(psRoot, 'readme.md'), 'pwsh -File x.ps1');
  const scanned = readPwshScripts(psRoot);
  check(scanned.map((f) => f.path).join() === 'moh.ps1,scripts/build.ps1' && scanned[1].text.length === PWSH_MAX_BYTES, 'pwsh scan: *.ps1 at the root and one folder down only (node_modules skipped), each read up to its cap');

  const shown = withPwshProfile({ theme: 'dark', profiles: { defaults: { font: {} } } }, true);
  const shownList = (shown?.profiles as { list: Record<string, unknown>[]; defaults?: unknown } | undefined);
  const tweaked = { profiles: { list: [{ guid: 'other' }, { guid: PWSH_PROFILE_GUID.toUpperCase(), name: 'My pwsh', fontSize: 14 }] } };
  const hidden = withPwshProfile(tweaked, false)?.profiles as { list: Record<string, unknown>[] } | undefined;
  check(shownList?.list.length === 1 && shownList.list[0].guid === PWSH_PROFILE_GUID && String(shownList.list[0].commandline).includes('pwsh.exe') && Boolean(shownList.defaults) && shown?.theme === 'dark' && withPwshProfile(shown!, true) === null && withPwshProfile({ profiles: { defaults: {} } }, false) === null, 'Windows Terminal: a PowerShell 7 profile is added once pwsh is installed, nothing rewritten when already there or never wanted');
  check(hidden?.list[1].hidden === true && hidden.list[1].name === 'My pwsh' && hidden.list[1].fontSize === 14 && hidden.list.length === 2 && (withPwshProfile({ profiles: [{ guid: 'a' }] }, true)?.profiles as { list: unknown[] }).list.length === 2, 'Windows Terminal: turning pwsh off hides the profile, keeping the user\'s edits; the old array form of "profiles" works');
  const wtData = path.join(t.temp, 'wt-data');
  const wtSettings = write(path.join(wtData, 'tools', 'terminal', 'settings', 'settings.json'), '// edited in the sandbox\n{ "theme": "light", "profiles": { "list": [{ "guid": "{x}", }] } }');
  syncPwshProfile(wtData, true);
  const before = fs.readFileSync(wtSettings, 'utf8');
  write(path.join(wtData, 'tools', 'pwsh', 'pwsh.exe'), 'MZ');
  syncPwshProfile(wtData, true);
  const after = JSON.parse(fs.readFileSync(wtSettings, 'utf8')) as { theme: string; profiles: { list: { guid: string; hidden?: boolean }[] } };
  syncPwshProfile(wtData, false);
  const off = JSON.parse(fs.readFileSync(wtSettings, 'utf8')) as typeof after;
  write(path.join(wtData, 'tools', 'terminal', 'settings', 'settings.json'), '{ not json');
  syncPwshProfile(wtData, true);
  check(before.startsWith('// edited') && after.theme === 'light' && after.profiles.list.map((p) => p.guid).join() === '{x},' + PWSH_PROFILE_GUID && off.profiles.list[1].hidden === true && fs.readFileSync(wtSettings, 'utf8') === '{ not json', 'Windows Terminal settings.json (JSONC): untouched until pwsh is installed, then the profile is added, hidden when off; an unreadable file is left alone');
};
