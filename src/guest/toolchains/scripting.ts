// Ruby (RubyInstaller) and PHP (windows.php.net, with Composer), plus the Visual C++ runtime PHP and other native
// tools need. Gems and Composer's global packages live in persistent storage.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Toolchains } from '../../core/types.js';
import { download, fetchJson, fetchText, installArchive } from '../../shared/download.js';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, exec, execOutput, exists, log, mkdirp } from '../env.js';
import { installOnce, resolveCached, tool, versionFromFiles, versionOf, type ToolEnv } from './common.js';
import { pickPackageVersion } from './versions.js';

/** Writes `<name>.cmd` into tools\shims (on PATH). */
const shim = (env: ToolEnv, name: string, command: string): void => {
  fs.writeFileSync(path.join(mkdirp(tool('shims')), name + '.cmd'), '@echo off\r\n' + command + ' %*\r\n');
  env.prepend.push(tool('shims'));
};

// ---- Visual C++ runtime ----------------------------------------------------------------------------------------------

const VC_REDIST = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

/**
 * vcruntime140.dll & co. A real installer (it writes to System32), so it runs on every boot; the installer itself is
 * kept in persistent storage and only run when Microsoft's signature on it checks out.
 */
export const setupVcRuntime = async (env: ToolEnv): Promise<void> => {
  if (dryRun) { log('(dry run) would install the Visual C++ runtime'); return; }
  const system32 = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32');
  if (!exists(path.join(system32, 'vcruntime140.dll')) || !exists(path.join(system32, 'msvcp140.dll'))) {
    const installer = tool('vcredist', 'vc_redist.x64.exe');
    if (!exists(installer)) { log('Downloading the Visual C++ runtime ...'); await download(VC_REDIST, installer); }
    const signer = execOutput(SYSTEM.powershell(), ['-NoLogo', '-NoProfile', '-Command', "$s = Get-AuthenticodeSignature -LiteralPath '" + installer.replace(/'/g, "''") + "'; if ($s.Status -eq 'Valid') { $s.SignerCertificate.Subject }"]);
    if (!/O=Microsoft Corporation/.test(signer)) { fs.rmSync(installer, { force: true }); throw new Error('vc_redist.x64.exe is not signed by Microsoft; deleted it (it is downloaded again next boot)'); }
    log('Installing the Visual C++ runtime ...');
    // 1638: a newer version is already installed; 3010: installed, a restart would finish it (not needed for the DLLs).
    const code = spawnSync(installer, ['/install', '/quiet', '/norestart'], { windowsHide: true, stdio: 'ignore' }).status;
    if (![0, 1638, 3010].includes(code ?? -1) || !exists(path.join(system32, 'vcruntime140.dll'))) throw new Error('the Visual C++ runtime installer failed (exit ' + code + ')');
  }
  env.summary.push('vc++ runtime: installed');
};

// ---- Ruby ------------------------------------------------------------------------------------------------------------

interface Release { draft: boolean; prerelease: boolean; assets: { name: string; browser_download_url: string; digest?: string }[] }
const RUBY_ASSET = /^rubyinstaller-(\d+\.\d+\.\d+)-(\d+)-x64\.7z$/;

/** RubyInstaller builds per Ruby version (newest build of each), from its GitHub releases. */
const rubyBuilds = async (): Promise<Map<string, Release['assets'][number]>> => {
  const releases = await fetchJson<Release[]>('https://api.github.com/repos/oneclick/rubyinstaller2/releases?per_page=100');
  const builds = new Map<string, Release['assets'][number]>();
  for (const asset of releases.filter((r) => !r.draft && !r.prerelease).flatMap((r) => r.assets)) {
    const match = RUBY_ASSET.exec(asset.name);
    const known = match && builds.get(match[1]);
    if (match && (!known || Number(RUBY_ASSET.exec(known.name)![2]) < Number(match[2]))) builds.set(match[1], asset);
  }
  return builds;
};

export const setupRuby = async (env: ToolEnv, config: Toolchains['ruby']): Promise<void> => {
  const wantedSpec = versionFromFiles(['.ruby-version']) ?? { spec: config.version, source: 'config' };
  if (dryRun) { log('(dry run) would provision Ruby ' + wantedSpec.spec); return; }
  const version = await resolveCached('ruby:' + wantedSpec.spec, async () => pickPackageVersion([...(await rubyBuilds()).keys()], wantedSpec.spec) ?? Promise.reject(new Error('No RubyInstaller build matches "' + wantedSpec.spec + '"')));
  const home = tool('ruby', version);
  if (!exists(path.join(home, 'bin', 'ruby.exe'))) {
    const asset = (await rubyBuilds()).get(version);
    if (!asset) throw new Error('RubyInstaller ' + version + ' is no longer published');
    log('Downloading ' + asset.name + ' ...');
    await installArchive(asset.browser_download_url, home, { sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null, locate: 'ruby.exe', up: 1, fileName: asset.name });
  }
  const gems = tool('ruby-gems', version.split('.').slice(0, 2).join('.'));
  Object.assign(env.vars, { GEM_HOME: gems, BUNDLE_USER_HOME: tool('bundle-home') });
  env.prepend.push(path.join(home, 'bin'), path.join(gems, 'bin'));
  env.summary.push('ruby: ' + versionOf(path.join(home, 'bin', 'ruby.exe')) + ' (from ' + wantedSpec.source + '; gems with C extensions need MSYS2, not included)');
  const gem = path.join(home, 'bin', 'gem.cmd');
  installOnce(env, 'gem@' + version, config.gems, (pkg) => exec(SYSTEM.cmd(), ['/d', '/c', gem, 'install', pkg, '--no-document'], { env: { ...process.env, GEM_HOME: gems } }));
};

// ---- PHP -------------------------------------------------------------------------------------------------------------

type PhpReleases = Record<string, { version: string } & Record<string, { zip?: { path: string; sha256: string } } | string>>;
const PHP_EXTENSIONS = ['curl', 'fileinfo', 'gd', 'intl', 'mbstring', 'openssl', 'pdo_mysql', 'pdo_pgsql', 'pdo_sqlite', 'sodium', 'sqlite3', 'zip'];

/** The non-thread-safe x64 zip of the newest release matching `spec` ("8" -> newest 8.x, "8.3" -> newest 8.3.x). */
const phpBuild = async (spec: string): Promise<{ version: string; path: string; sha256: string }> => {
  const releases = await fetchJson<PhpReleases>('https://windows.php.net/downloads/releases/releases.json');
  const pick = pickPackageVersion(Object.values(releases).map((r) => r.version), spec);
  const release = Object.values(releases).find((r) => r.version === pick);
  const build = release && Object.entries(release).find(([key, value]) => /^nts-vs\d+-x64$/.test(key) && typeof value === 'object' && value.zip)?.[1];
  if (!release || typeof build !== 'object' || !build.zip) throw new Error('No PHP build for Windows matches "' + spec + '"');
  return { version: release.version, ...build.zip };
};

/** php.ini from the development template with the common extensions switched on. */
const writePhpIni = (home: string): void => {
  const ini = path.join(home, 'php.ini');
  if (exists(ini) || !exists(path.join(home, 'php.ini-development'))) return;
  let text = fs.readFileSync(path.join(home, 'php.ini-development'), 'utf8')
    .replace(/^;\s*extension_dir\s*=\s*"ext"/m, 'extension_dir = "' + path.join(home, 'ext') + '"');
  for (const ext of PHP_EXTENSIONS.filter((e) => exists(path.join(home, 'ext', 'php_' + e + '.dll')))) text = text.replace(new RegExp('^;(extension=' + ext + ')\s*$', 'm'), '$1');
  fs.writeFileSync(ini, text);
};

export const setupPhp = async (env: ToolEnv, config: Toolchains['php']): Promise<void> => {
  const wantedSpec = versionFromFiles(['.php-version']) ?? { spec: config.version, source: 'config' };
  if (dryRun) { log('(dry run) would provision PHP ' + wantedSpec.spec + (config.composer ? ' + Composer' : '')); return; }
  await setupVcRuntime(env);
  const version = await resolveCached('php:' + wantedSpec.spec, async () => (await phpBuild(wantedSpec.spec)).version);
  const home = tool('php', version);
  if (!exists(path.join(home, 'php.exe'))) {
    const build = await phpBuild(version);
    log('Downloading ' + build.path + ' ...');
    await installArchive('https://windows.php.net/downloads/releases/' + build.path, home, { sha256: build.sha256, locate: 'php.exe', fileName: build.path });
  }
  writePhpIni(home);
  env.prepend.push(home);
  env.summary.push('php: ' + version + ' (from ' + wantedSpec.source + ')');
  if (!config.composer) return;
  const phar = tool('composer', 'composer.phar');
  if (!exists(phar)) {
    log('Downloading Composer ...');
    await download('https://getcomposer.org/download/latest-stable/composer.phar', phar, (await fetchText('https://getcomposer.org/download/latest-stable/composer.phar.sha256sum')).trim().split(/\s+/)[0]);
  }
  const composerHome = tool('composer-home');
  env.vars.COMPOSER_HOME = composerHome;
  env.prepend.push(path.join(composerHome, 'vendor', 'bin'));
  shim(env, 'composer', '"' + path.join(home, 'php.exe') + '" "' + phar + '"');
  env.summary.push('composer: ' + (/\d+\.\d+\.\d+/.exec(execOutput(path.join(home, 'php.exe'), [phar, '--version', '--no-ansi']))?.[0] ?? 'installed'));
};
