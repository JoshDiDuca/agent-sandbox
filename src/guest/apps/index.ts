// Installs the apps you chose (apps.install from the catalogue, apps.custom of your own) into C:\AgentData\tools\apps,
// once each: later sandboxes find them there. Programs get a desktop and Start menu shortcut; command-line tools go on
// PATH. Installers are never run: archives are unpacked, NSIS installers opened with 7-Zip and MSIs extracted
// (msiexec /a), so nothing is registered and nothing is lost when the sandbox closes. One app failing never stops the
// others.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, GitAccess } from '../../core/types.js';
import { appsToInstall, exeMatcher, type AppEntry } from '../../shared/apps.js';
import { download, extractArchive, githubAsset, moveIntoPlace, stagingFolder } from '../../shared/download.js';
import { safeRemove } from '../../shared/safe-remove.js';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, errMsg, execAsync, exists, log, mkdirp, powershell, warn } from '../env.js';
import { arch, tool, type ToolEnv } from '../toolchains/common.js';
import { RESOLVERS, type Download } from './resolvers.js';

export { appsNeedMesa } from '../../shared/apps.js';

export interface AppsOptions {
  gitAccess: GitAccess;
  refresh: boolean;
}

const MARKER = '.agent-sandbox-app';
/** How many apps download and unpack at once (they are big: a few at a time keeps the disk and network busy). */
const PARALLEL = 3;

const sevenZip = (): string => tool('apps', '7zip', '7z.exe');

/** Where to download an entry from. */
const resolve = async (entry: AppEntry): Promise<Download> => {
  const s = entry.source;
  if ('github' in s) {
    const a = await githubAsset(s.github, new RegExp(s.asset), true);
    return { url: a.url, fileName: a.name, sha256: a.sha256 };
  }
  if ('url' in s) {
    const name = decodeURIComponent(new URL(s.url).pathname.split('/').pop() || entry.id);
    return { url: s.url, fileName: /\.\w{2,5}$/.test(name) ? name : name + '.zip' };
  }
  if ('resolve' in s && RESOLVERS[s.resolve]) return RESOLVERS[s.resolve]();
  throw new Error('no download source for ' + entry.name);
};

/** The program in an installed folder (breadth first, bounded: big apps have tens of thousands of files). */
export const findExe = (root: string, exe: string): string | null => {
  const match = exeMatcher(exe);
  let queue = [root];
  let seen = 0;
  for (let depth = 0; depth < 7 && queue.length; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const hit = entries.find((e) => e.isFile() && match(e.name));
      if (hit) return path.join(dir, hit.name);
      next.push(...entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => path.join(dir, e.name)));
      if ((seen += entries.length) > 50000) return null;
    }
    queue = next;
  }
  return null;
};

/** Downloads and unpacks one entry into its folder (replaced in one step: never half there). */
const installApp = async (entry: AppEntry, dest: string): Promise<void> => {
  const work = stagingFolder(dest);
  const out = path.join(work, 'out');
  try {
    if ('npm' in entry.source) {
      const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      log('Installing ' + entry.name + ' (npm) ...');
      await execAsync(process.execPath, [
        npmCli,
        'install',
        '--prefix',
        mkdirp(out),
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        entry.source.npm,
      ]);
    } else {
      const d = await resolve(entry);
      log('Downloading ' + entry.name + ' (' + d.fileName + ', ~' + entry.size + ' once) ...');
      const file = path.join(mkdirp(work), d.fileName.replace(/[\\/:*?"<>|]/g, '_'));
      await download(d.url, file, { sha256: d.sha256 ?? null });
      await unpack(entry, file, out, d);
    }
    fs.writeFileSync(path.join(out, MARKER), JSON.stringify({ id: entry.id, at: new Date().toISOString() }));
    moveIntoPlace(out, dest);
  } finally {
    safeRemove(work, path.dirname(work));
  }
};

const unpack = async (entry: AppEntry, file: string, out: string, d: Download): Promise<void> => {
  if (entry.id === '7zip') {
    // 7zr.exe (the small standalone 7-Zip) opens the full 7-Zip's installer.
    const sevenZr = path.join(path.dirname(file), '7zr.exe');
    const zr = await githubAsset('ip7z/7zip', /^7zr\.exe$/);
    await download(zr.url, sevenZr, zr.sha256);
    await execAsync(sevenZr, ['x', '-y', '-o' + out, file], { stdio: 'ignore' });
    return;
  }
  switch (entry.unpack ?? 'archive') {
    case 'file': {
      mkdirp(out);
      fs.renameSync(file, path.join(out, /^\//.test(entry.exe) ? path.basename(file) : entry.exe));
      return;
    }
    case 'nsis': {
      if (!exists(sevenZip()))
        throw new Error('7-Zip is needed to unpack ' + entry.name + ' and could not be installed');
      const raw = path.join(path.dirname(out), 'raw');
      await execAsync(sevenZip(), ['x', '-y', '-o' + raw, file], { stdio: 'ignore' });
      // electron-builder installers carry the app as one more archive inside.
      const inner = findExe(raw, '/^app-64\\.7z$/');
      if (inner) await execAsync(sevenZip(), ['x', '-y', '-o' + out, inner], { stdio: 'ignore' });
      else fs.renameSync(raw, out);
      return;
    }
    case 'msi': {
      // An administrative install only extracts the files: nothing is registered with Windows.
      mkdirp(out);
      await execAsync(SYSTEM.msiexec(), ['/a', file, '/qn', 'TARGETDIR=' + out], { stdio: 'ignore' });
      return;
    }
    default:
      await extractArchive(file, out, d.members);
  }
};

/** Settings an app needs on every boot (the sandbox's registry is new each time), and files next to its program. */
const afterInstall = async (entry: AppEntry, exe: string): Promise<void> => {
  const dir = path.dirname(exe);
  if (entry.needs?.includes('mesa')) {
    const mesa = tool('mesa', arch === 'arm64' ? 'arm64' : 'x64');
    for (const dll of ['opengl32.dll', 'libgallium_wgl.dll', 'dxil.dll']) {
      if (exists(path.join(mesa, dll)) && !exists(path.join(dir, dll)))
        fs.copyFileSync(path.join(mesa, dll), path.join(dir, dll));
    }
  }
  // Godot and Sublime keep their settings next to the program instead of in the profile, which is wiped on close.
  if (entry.id === 'godot' && !exists(path.join(dir, '._sc_'))) fs.writeFileSync(path.join(dir, '._sc_'), '');
  if (entry.id === 'sublime') mkdirp(path.join(dir, 'Data'));
  if (entry.id === 'sysinternals') {
    for (const name of [
      'Process Explorer',
      'Process Monitor',
      'Autoruns',
      'TCPView',
      'PsExec',
      'PsList',
      'PsKill',
      'Handle',
      'ListDLLs',
      'Sigcheck',
      'Strings',
      'VMMap',
      'RAMMap',
      'DebugView',
      'Disk2vhd',
      'Du',
      'ZoomIt',
    ]) {
      await execAsync(
        SYSTEM.reg(),
        ['add', 'HKCU\\Software\\Sysinternals\\' + name, '/v', 'EulaAccepted', '/t', 'REG_DWORD', '/d', '1', '/f'],
        { stdio: 'ignore' },
      ).catch(() => undefined);
    }
  }
};

/** Desktop and Start menu shortcuts, all in one PowerShell call. */
const shortcuts = (apps: { name: string; exe: string }[]): void => {
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

export const setupApps = async (env: ToolEnv, apps: Config['apps'], o: AppsOptions): Promise<void> => {
  const { entries, skipped } = appsToInstall(apps, o.gitAccess);
  for (const s of skipped) env.summary.push('app skipped: ' + s);
  if (dryRun) {
    log('(dry run) would install apps: ' + entries.map((e) => e.name).join(', '));
    return;
  }
  const gui: { name: string; exe: string }[] = [];
  const installed: string[] = [];
  const one = async (entry: AppEntry): Promise<void> => {
    try {
      const dest = tool('apps', ...entry.id.split('/'));
      if (!exists(path.join(dest, MARKER)) || o.refresh) await installApp(entry, dest);
      const exe = findExe(dest, entry.exe);
      if (!exe) throw new Error(entry.exe + ' not found in the download');
      await afterInstall(entry, exe);
      if (entry.cli || entry.id === 'sysinternals') env.prepend.push(path.dirname(exe));
      if (!entry.cli) gui.push({ name: entry.name, exe });
      installed.push(entry.name);
    } catch (e) {
      warn(
        entry.name + ' could not be installed and is skipped; the other apps are not affected. Reason: ' + errMsg(e),
      );
      env.summary.push(entry.name + ': FAILED');
    }
  };
  // 7-Zip first: the NSIS apps need it to unpack.
  const [first, rest] = entries[0]?.id === '7zip' ? [[entries[0]], entries.slice(1)] : [[], entries];
  for (const e of first) await one(e);
  const queue = [...rest];
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let e = queue.shift(); e; e = queue.shift()) await one(e);
    }),
  );
  try {
    shortcuts(gui);
  } catch (e) {
    warn('App shortcuts could not be created: ' + errMsg(e));
  }
  if (installed.length)
    env.summary.push('apps: ' + installed.join(', ') + ' (shortcuts on the desktop and in Start > Sandbox apps)');
};
