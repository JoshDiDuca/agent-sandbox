import fs from 'node:fs';
import path from 'node:path';
import type { Config, GitAccess } from '../../core/types.js';
import { appsToInstall, type AppEntry } from '../../shared/apps/index.js';
import { download, moveIntoPlace, stagingFolder } from '../../shared/download/index.js';
import { safeRemove } from '../../shared/io/safe-remove.js';
import { SYSTEM } from '../../shared/system.js';
import { dryRun } from '../runtime/paths.js';
import { execAsync } from '../runtime/process.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log, warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';
import { arch, tool, type ToolEnv } from '../toolchains/tool-env.js';
import { resolve } from './sources.js';
import { unpack } from './unpack.js';
import { findExe } from './find-exe.js';
import { shortcuts } from './shortcuts.js';

export interface AppsOptions {
  gitAccess: GitAccess;
  refresh: boolean;
}

const MARKER = '.agent-sandbox-app';
/** How many apps download and unpack at once (they are big: a few at a time keeps the disk and network busy). */
const PARALLEL = 3;

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
