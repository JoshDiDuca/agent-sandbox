// Small pure helpers: version picking, .reg generation, firewall maths, storage cleanup.
import fs from 'node:fs';
import path from 'node:path';
import { pruneStorage } from '../host/cleanup.js';
import { toRegFile } from '../host/personalize.js';
import { javaMajorFrom, pickGoRelease, pickNodeVersion, pickPackageVersion, pickSpreadVersions, projectUses, specFromVersionFile } from '../guest/toolchains/versions.js';
import { buildFirewallCommands, cidrToRange, parseDefaultGateways, parseDnsServers, subtractIps } from '../shared/netrules.js';
import { ensureDir } from '../core/util.js';
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
