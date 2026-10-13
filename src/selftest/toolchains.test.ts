// Picking tool versions and release assets: Node/Go/Python/Java version rules, GitHub release pages, PowerShell 7,
// cargo-binstall, the small CLI tools (gh, zstd, openssl), and when PowerShell 7 is wanted.
import path from 'node:path';
import {
  javaMajorFrom,
  pickGoRelease,
  pickNodeVersion,
  pickPackageVersion,
  pickSpreadVersions,
  projectUses,
  specFromVersionFile,
} from '../core/detect/index.js';
import { parseReleasePage, parseReleaseTags } from '../shared/download/index.js';
import { decidePwsh, pcHasPwsh, PWSH_MAX_BYTES, readPwshScripts, usesPwsh } from '../core/detect/index.js';
import { binstallAsset, CLI_TOOLS, decideCli, pwshAsset, type CliSettings } from '../guest/toolchains/catalogue.js';
import { missingExtensions, vscodeExtensions, vscodeSettings } from '../guest/toolchains/vscode-profile.js';
import { APP_CATEGORIES, APPS, appsNeedMesa, appsToInstall, exeMatcher } from '../shared/apps/index.js';
import { Config, LocalOverrides } from '../core/schema/index.js';
import type { Suite } from './suite.js';

export const toolchainsSuite: Suite = {
  name: 'toolchains',
  title: 'version pickers, release assets, PowerShell 7 and CLI tool decisions',
  run: (t) => {
    t.section('version pickers');
    const releases = [
      { version: 'v23.1.0', lts: false as const },
      { version: 'v22.11.0', lts: 'Jod' },
      { version: 'v20.18.0', lts: 'Iron' },
      { version: 'v20.9.0', lts: 'Iron' },
    ];
    const node = (spec: string): string | null => pickNodeVersion(releases, spec);
    t.equal(
      [node('lts/*'), node('lts/iron'), node('20'), node('v20.9.0'), node('node'), node('99')],
      ['22.11.0', '20.18.0', '20.18.0', '20.9.0', '23.1.0', null],
      '.nvmrc specs resolve (lts/*, lts/<name>, major, exact, node)',
    );
    const installed = ['16.20.2', '18.19.0', '18.20.4', '20.18.0', '22.3.0', '22.11.0', '23.1.0', 'notes'];
    t.equal(
      pickSpreadVersions(installed, '22.11.0', 3),
      ['22.11.0', '16.20.2', '23.1.0'],
      'host nvm versions: capped, the current one first, the rest spread across other majors',
    );
    t.equal(
      pickSpreadVersions(['20.18.0'], '22.3.0', 3),
      ['22.3.0', '20.18.0'],
      'host nvm versions: a missing current version is added first',
    );
    t.equal(pickSpreadVersions(['18.20.4', '20.18.0'], '22.3.0', 1), ['22.3.0'], 'host nvm versions: the cap wins');
    const go = [
      { version: 'go1.24rc1', stable: false, files: [] },
      { version: 'go1.23.2', stable: true, files: [] },
      { version: 'go1.23.1', stable: true, files: [] },
      { version: 'go1.22.8', stable: true, files: [] },
    ];
    t.equal(
      [
        pickGoRelease(go, 'stable')?.version,
        pickGoRelease(go, '1.22')?.version,
        pickGoRelease(go, 'go1.23.1')?.version,
        pickGoRelease(go, '1.30'),
      ],
      ['go1.23.2', 'go1.22.8', 'go1.23.1', null],
      'Go versions resolve (stable, minor prefix, exact); release candidates are skipped',
    );
    t.equal(
      [
        javaMajorFrom('21\n'),
        javaMajorFrom('17.0.9'),
        javaMajorFrom('1.8'),
        javaMajorFrom('temurin-21.0.2'),
        javaMajorFrom('# sdkman\njava=21.0.2-tem\n', true),
      ],
      ['21', '17', '8', '21', '21'],
      'version files: .java-version and .sdkmanrc',
    );
    t.equal(specFromVersionFile('ruby-3.3.1\n'), '3.3.1', 'version files: .ruby-version');
    t.check(
      projectUses(['README.md', 'server/go.mod'], ['go.mod']) && projectUses(['App.csproj'], ['*.csproj']),
      'enabled "auto": a language is used when its marker file is in the workspace or one folder down',
    );
    t.check(
      !projectUses(['notes.txt', 'docs/readme.md'], ['go.mod', '*.csproj']),
      'enabled "auto": a language is not used without its marker file',
    );
    const python = ['3.9.13', '3.12.7', '3.12.10', '3.13.0-rc1', '3.13.1'];
    t.equal(
      [
        pickPackageVersion(python, '3'),
        pickPackageVersion(['3.12.7', '3.12.10'], '3.12'),
        pickPackageVersion(['2.7.18'], '2.7'),
      ],
      ['3.13.1', '3.12.10', '2.7.18'],
      'Python versions resolve to the newest stable match',
    );

    t.section('GitHub release pages (the fallback when the API is rate limited)');
    const tags =
      '<a href="/coreybutler/nvm-windows/releases/tag/1.2.2">x</a><a href="/coreybutler/nvm-windows/releases/tag/1.2.2">y</a><a href="/other/repo/releases/tag/9">z</a><a href="/coreybutler/nvm-windows/releases/tag/1.1.12">w</a>';
    t.equal(
      parseReleaseTags(tags, 'coreybutler/nvm-windows'),
      ['1.2.2', '1.1.12'],
      "release list page: this repo's tags in order, once each",
    );
    const page =
      '<a href="/o/r/releases/download/v1/tool-win-x64.zip">x</a><span>sha256:' +
      'a'.repeat(64) +
      '</span><a href="/o/r/releases/download/v1/tool-linux.tar.gz">y</a>';
    const assets = parseReleasePage(page);
    t.equal(assets.length, 2, 'release page: both assets are found');
    t.equal(
      assets[0].url,
      'https://github.com/o/r/releases/download/v1/tool-win-x64.zip',
      'release page: asset links become full URLs',
    );
    t.equal(
      [assets[0].sha256, assets[1].sha256],
      ['a'.repeat(64), null],
      "release page: only an asset's own sha256 is used",
    );

    t.section('release assets per architecture');
    const matching = (pattern: RegExp, names: string[]): string[] => names.filter((n) => pattern.test(n));
    const pwshNames = [
      'PowerShell-7.6.6-win-x64.zip',
      'PowerShell-7.6.6-win-arm64.zip',
      'PowerShell-7.6.6-win-x64.msi',
      'PowerShell-7.6.6-win-fxdependent.zip',
      'PowerShell-7.6.6-win-x86.zip',
      'PowerShell-7.6.6-win-x64.zip.sha256',
    ];
    t.equal(
      matching(pwshAsset('x64'), pwshNames),
      ['PowerShell-7.6.6-win-x64.zip'],
      'PowerShell 7 (x64): the portable zip, not the MSI, fxdependent or x86 build',
    );
    t.equal(
      matching(pwshAsset('arm64'), pwshNames),
      ['PowerShell-7.6.6-win-arm64.zip'],
      'PowerShell 7 (arm64): the portable zip',
    );
    const binstallNames = [
      'cargo-binstall-x86_64-pc-windows-msvc.zip',
      'cargo-binstall-x86_64-pc-windows-msvc.full.zip',
      'cargo-binstall-x86_64-pc-windows-msvc.zip.sig',
      'cargo-binstall-aarch64-pc-windows-msvc.zip',
      'cargo-binstall-x86_64-unknown-linux-musl.tgz',
    ];
    t.equal(
      matching(binstallAsset('x64'), binstallNames),
      ['cargo-binstall-x86_64-pc-windows-msvc.zip'],
      'cargo-binstall (x64): the plain Windows zip, not .full or the signature',
    );
    t.equal(
      matching(binstallAsset('arm64'), binstallNames),
      ['cargo-binstall-aarch64-pc-windows-msvc.zip'],
      'cargo-binstall (arm64): the plain Windows zip',
    );
    const cliAsset = (name: string, arch: 'x64' | 'arm64', names: string[]): string[] =>
      matching(CLI_TOOLS.find((c) => c.name === name)!.asset(arch), names);
    const ghNames = [
      'gh_2.102.0_windows_amd64.zip',
      'gh_2.102.0_windows_amd64.msi',
      'gh_2.102.0_windows_386.zip',
      'gh_2.102.0_windows_arm64.zip',
      'gh_2.102.0_linux_amd64.tar.gz',
    ];
    const zstdNames = ['zstd-v1.5.7-win64.zip', 'zstd-v1.5.7-win32.zip', 'zstd-v1.5.7.tar.gz'];
    t.equal(cliAsset('gh', 'x64', ghNames), ['gh_2.102.0_windows_amd64.zip'], 'CLI catalogue: gh zip for x64');
    t.equal(cliAsset('gh', 'arm64', ghNames), ['gh_2.102.0_windows_arm64.zip'], 'CLI catalogue: gh zip for arm64');
    t.equal(cliAsset('zstd', 'x64', zstdNames), ['zstd-v1.5.7-win64.zip'], 'CLI catalogue: zstd win64 zip for x64');
    t.equal(
      cliAsset('zstd', 'arm64', zstdNames),
      ['zstd-v1.5.7-win64.zip'],
      'CLI catalogue: zstd win64 also serves Arm',
    );
    t.check(
      CLI_TOOLS.every((c) => c.exe.endsWith('.exe')),
      'CLI catalogue: every tool is an .exe',
    );

    t.section('which CLI tools are installed');
    const cli = (settings: CliSettings, gitAccess: 'full' | 'readonly' | 'none', hasGithubDir = false): string =>
      Object.entries(decideCli(settings, { gitAccess, hasGithubDir }))
        .filter(([, d]) => d.on)
        .map(([n]) => n)
        .join();
    t.equal(
      cli({ gh: true, zstd: true, openssl: true }, 'full'),
      'gh,zstd,openssl',
      'CLI tools: everything asked for is installed with git access "full"',
    );
    t.equal(
      cli({ gh: true, zstd: true }, 'readonly'),
      'zstd',
      'CLI tools: gh needs git access "full" (it pushes through the API), whatever the config says',
    );
    t.equal(cli({ gh: 'auto' }, 'none', true), '', 'CLI tools: no git access, no gh');
    t.includes(
      decideCli({ gh: true }, { gitAccess: 'readonly', hasGithubDir: false }).gh.reason,
      '"full"',
      'CLI tools: the reason for leaving gh out names git access "full"',
    );
    t.equal(
      cli({ gh: 'auto', zstd: 'auto', openssl: 'auto' }, 'full', true),
      'gh,openssl',
      'CLI tools "auto": gh with a .github folder, openssl always (a shim), zstd only when listed',
    );
    t.equal(cli({ gh: 'auto', zstd: 'auto' }, 'full', false), '', 'CLI tools "auto": gh needs a .github folder');
    t.equal(cli({}, 'full', true), '', 'CLI tools: unlisted tools stay off');

    t.section('PowerShell 7: when a script needs it');
    const ps = (text: string, file = 'moh.ps1'): string | null => usesPwsh([{ path: file, text }]);
    t.equal(
      ps('#Requires -Version 7.2\nparam()'),
      'moh.ps1: #Requires -Version 7',
      'marker: #Requires -Version 7+ (and the file that said so)',
    );
    t.check(ps('  #requires -PSEdition Core') !== null, 'marker: #Requires -PSEdition Core');
    t.check(ps('#Requires -Modules Pester -Version 7') !== null, 'marker: #Requires with a module list and -Version 7');
    t.check(
      ps('<#\n.SYNOPSIS\n  Usage: pwsh scripts/moh/build-openmohaa.ps1 -Release\n#>') !== null,
      'marker: a usage line that runs pwsh',
    );
    t.check(ps('& pwsh.exe -NoProfile -File x.ps1') !== null, 'marker: a call to pwsh.exe');
    t.check(ps('C:\\Program Files\\PowerShell\\7\\pwsh.exe -c 1') !== null, 'marker: a full path to pwsh.exe');
    t.equal(ps('#Requires -Version 5.1'), null, 'not a marker: #Requires -Version 5.1');
    t.equal(ps('#Requires -PSEdition Desktop'), null, 'not a marker: -PSEdition Desktop');
    t.equal(ps('# Works in Windows PowerShell and pwsh too.'), null, 'not a marker: prose that mentions pwsh');
    t.equal(ps('$pwsh -x; Write-Host mypwsh -y'), null, 'not a marker: variables and longer words');
    t.equal(ps('#Requires -Version 7', 'notes.txt'), null, 'not a marker: files that are not scripts');
    t.equal(ps('Write-Host hi'), null, 'not a marker: an ordinary script');

    // Hostile scripts (a cloned repository is untrusted): capped and scanned in linear time.
    const evilStart = Date.now();
    const evilText = (
      ' #requires' +
      ' -version'.repeat(5000) +
      '\n' +
      'xpwsh pwsh\t\t'.repeat(20000) +
      '\n' +
      ' '.repeat(100000) +
      'pwsh\n' +
      'pwsh\n'.repeat(50000)
    ).repeat(3);
    const evil = usesPwsh(Array.from({ length: 100 }, (_, i) => ({ path: 'a' + i + '.ps1', text: evilText })));
    const evilMs = Date.now() - evilStart;
    t.equal(evil, null, 'hostile scripts (huge lines, endless repeats) do not match');
    t.check(evilMs < 2000, 'hostile scripts are capped and scanned in linear time', 'took ' + evilMs + ' ms');

    const needsIt = [{ path: 'x/run.ps1', text: '#Requires -PSEdition Core' }];
    t.check(decidePwsh('auto', [], true, true).on, 'pwsh "auto": this PC has it and the folder is new -> on');
    t.check(!decidePwsh('auto', [], false, true).on, 'pwsh "auto": this PC does not have it -> off');
    t.check(!decidePwsh('auto', [], true, false).on, 'pwsh "auto": an existing project that does not need it -> off');
    t.equal(
      decidePwsh('auto', needsIt, false, false).reason,
      'x/run.ps1: #Requires -PSEdition Core',
      'pwsh "auto": a script that needs it turns it on, and is named',
    );
    t.check(
      !decidePwsh(false, [{ path: 'a.ps1', text: '#Requires -Version 7' }], true, true).on,
      'pwsh false always wins',
    );
    t.check(decidePwsh(true, [], false, false).on, 'pwsh true always wins');
    const programFiles = 'C:\\PF';
    t.check(
      pcHasPwsh({ ProgramFiles: programFiles }, (p) => p === 'C:\\PF\\PowerShell\\7\\pwsh.exe'),
      'pwsh on this PC: found in Program Files\\PowerShell\\7',
    );
    t.check(
      pcHasPwsh({ PATH: 'C:\\x;C:\\tools\\pwsh' }, (p) => p === 'C:\\tools\\pwsh\\pwsh.exe'),
      'pwsh on this PC: found on PATH',
    );
    t.check(
      !pcHasPwsh({ ProgramFiles: programFiles, PATH: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps' }, (p) =>
        /WindowsApps/.test(p),
      ),
      'pwsh on this PC: a Store alias does not count',
    );

    const scanRoot = t.at('pwsh-scan');
    t.write(path.join(scanRoot, 'moh.ps1'), '#Requires -Version 7\n');
    t.write(path.join(scanRoot, 'scripts', 'build.ps1'), 'x'.repeat(200000) + '\n#Requires -Version 7');
    t.write(path.join(scanRoot, 'node_modules', 'pkg.ps1'), '#Requires -Version 7');
    t.write(path.join(scanRoot, 'scripts', 'deep', 'far.ps1'), '#Requires -Version 7');
    t.write(path.join(scanRoot, 'readme.md'), 'pwsh -File x.ps1');
    const scanned = readPwshScripts(scanRoot);
    t.equal(
      scanned.map((s) => s.path),
      ['moh.ps1', 'scripts/build.ps1'],
      'pwsh scan: *.ps1 at the root and one folder down only (node_modules skipped)',
    );
    t.equal(scanned[1].text.length, PWSH_MAX_BYTES, 'pwsh scan: each script is read up to its cap');

    t.section('VS Code set-up');
    const vs = vscodeSettings({
      javaHome: 'C:\\t\\java\\jdk-17.0.9+9',
      python: 'C:\\t\\python\\python.exe',
      pwsh: 'C:\\t\\pwsh\\pwsh.exe',
      gcc: 'C:\\t\\mingw\\bin\\gcc.exe',
      cl: 'C:\\t\\msvc\\cl.exe',
      dotnet: 'C:\\t\\dotnet\\dotnet.exe',
    });
    t.equal(
      [
        vs['java.jdt.ls.java.home'],
        (vs['java.configuration.runtimes'] as { name: string }[])[0].name,
        vs['python.defaultInterpreterPath'],
        vs['terminal.integrated.defaultProfile.windows'],
        vs['C_Cpp.default.compilerPath'],
        vs['dotnet.dotnetPath'],
      ],
      [
        'C:\\t\\java\\jdk-17.0.9+9',
        'JavaSE-17',
        'C:\\t\\python\\python.exe',
        'PowerShell 7',
        'C:\\t\\msvc\\cl.exe',
        'C:\\t\\dotnet',
      ],
      "vscode: settings point at the sandbox's JDK (with its version), Python, PowerShell 7, compiler (MSVC first) and .NET",
    );
    t.check(!('go.goroot' in vs) && !('git.path' in vs), 'vscode: tools that are not installed are not set');
    const ext = vscodeExtensions({
      toolchains: ['node', 'java'],
      databases: ['postgres'],
      recommended: ['Foo.Bar', 'not an id'],
      extra: ['eamodio.gitlens', 'redhat.java'],
    });
    t.check(
      ext.includes('redhat.java') &&
        ext.includes('mtxr.sqltools-driver-pg') &&
        ext.includes('foo.bar') &&
        ext.includes('eamodio.gitlens') &&
        !ext.includes('not an id') &&
        ext.filter((e) => e === 'redhat.java').length === 1,
      "vscode: extensions for the languages and databases in use, the project's and yours (no duplicates, nothing malformed)",
    );
    t.equal(
      missingExtensions(['golang.go', 'redhat.java'], ['golang.go-0.48.0', 'extensions.json']),
      ['redhat.java'],
      'vscode: only extensions not installed yet are downloaded',
    );

    t.section('apps catalogue');
    const ids = APPS.map((a) => a.id);
    t.equal(
      ids.filter((id, i) => ids.indexOf(id) !== i),
      [],
      'apps: every id is unique',
    );
    t.equal(
      APPS.filter((a) => !APP_CATEGORIES.some((c) => c.id === a.category)).map((a) => a.id),
      [],
      'apps: every app is in a known category',
    );
    t.equal(
      APPS.filter(
        (a) =>
          'github' in a.source &&
          (() => {
            try {
              new RegExp(a.source.asset);
              return false;
            } catch {
              return true;
            }
          })(),
      ).map((a) => a.id),
      [],
      'apps: every GitHub asset pattern compiles',
    );
    t.check(
      exeMatcher('/^Godot_v[\\d.]+-stable_win64\\.exe$/')('Godot_v4.7.2-stable_win64.exe') &&
        !exeMatcher('/^Godot_v[\\d.]+-stable_win64\\.exe$/')('Godot_v4.7.2-stable_win64_console.exe') &&
        exeMatcher('Code.exe')('code.EXE'),
      'apps: the program is found by name or by pattern',
    );
    const chosen = appsToInstall(
      {
        install: ['firefox', 'jq', 'githubdesktop'],
        custom: { mine: { name: 'Mine', url: 'https://example.com/m.zip', exe: 'm.exe' } },
      },
      'readonly',
    );
    t.equal(
      chosen.entries.map((e) => e.id),
      ['7zip', 'firefox', 'jq', 'custom/mine'],
      'apps: 7-Zip comes first when an installer needs it; your own programs follow',
    );
    t.equal(
      chosen.skipped.length,
      1,
      'apps: an app with its own git (GitHub Desktop) is skipped unless git access is "full"',
    );
    t.check(
      appsNeedMesa({ install: ['godot'], custom: {} }) && !appsNeedMesa({ install: ['jq'], custom: {} }),
      'apps: game engines bring Mesa (OpenGL without a GPU) along',
    );
    const custom = (app: object): boolean => Config.shape.apps.shape.custom.safeParse({ x: app }).success;
    t.check(
      custom({ name: 'A', github: 'o/r', asset: 'win.*\\.zip$', exe: 'a.exe' }) &&
        custom({ name: 'B', url: 'https://x.org/b.zip', exe: 'b.exe' }),
      'apps: your own program comes from a GitHub release or an https link',
    );
    t.check(
      !custom({ name: 'C', url: 'http://x.org/c.zip', exe: 'c.exe' }) &&
        !custom({ name: 'D', github: 'o/r', asset: '(', exe: 'd.exe' }) &&
        !custom({ name: 'E', github: 'o/r', asset: 'x', url: 'https://x.org', exe: 'e.exe' }),
      'apps: plain http, a broken pattern, or both sources are refused',
    );
    t.check(
      !LocalOverrides.safeParse({ apps: { custom: {} } }).success &&
        LocalOverrides.safeParse({ apps: { install: ['jq'] } }).success,
      'apps: a project file may add catalogue apps but never programs of its own',
    );
  },
};
