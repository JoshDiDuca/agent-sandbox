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
};
