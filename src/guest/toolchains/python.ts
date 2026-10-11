// Python 3 and Python 2: full CPython from the official NuGet packages (portable, with pip).
import fs from 'node:fs';
import path from 'node:path';
import type { Toolchains, ToolVersions } from '../../core/types.js';
import { fetchJson, installArchive } from '../../shared/download.js';
import { dryRun, execAsync, exists, log, mkdirp } from '../env.js';
import { resolveCached, tool, type ToolEnv } from './common.js';
import { pickPackageVersion } from './versions.js';
import { duringSession } from '../project-context.js';

type Package = 'python' | 'python2';

const installPython = async (pkg: Package, spec: string): Promise<string> => {
  const version = await resolveCached(pkg + ':' + spec, async () => {
    const { versions } = await fetchJson<{ versions: string[] }>('https://api.nuget.org/v3-flatcontainer/' + pkg + '/index.json');
    return pickPackageVersion(versions, spec) ?? Promise.reject(new Error('No ' + pkg + ' release matches "' + spec + '"'));
  });
  const dir = tool('python', pkg + '-' + version);
  const exe = path.join(dir, 'python.exe');
  if (!exists(exe)) {
    log('Downloading Python ' + version + (pkg === 'python2' ? ' (Python 2, ' : ' (') + '~30 MB once) ...');
    await installArchive('https://api.nuget.org/v3-flatcontainer/' + pkg + '/' + version + '/' + pkg + '.' + version + '.nupkg', dir, { locate: 'python.exe', fileName: pkg + '.' + version + '.zip' });
  }
  if (!exists(path.join(dir, 'Scripts', 'pip.exe')) && !exists(path.join(dir, 'Scripts', 'pip2.exe'))) await execAsync(exe, ['-m', 'ensurepip', '--default-pip'], { stdio: 'ignore' });
  return dir;
};

/**
 * The shims folder: tools\shims at boot. A project added later gets one per Python version (tools\shims\<version>)
 * so the boot project's python3.cmd keeps pointing at its own version.
 */
const shimDir = (dir: string): string => (duringSession() ? tool('shims', path.basename(dir)) : tool('shims'));

/** Writes `<name>.cmd` into the shims folder, e.g. python2.cmd. */
const shim = (folder: string, name: string, command: string): void => {
  fs.writeFileSync(path.join(mkdirp(folder), name + '.cmd'), '@echo off\r\n' + command + ' %*\r\n');
};

const shimPair = (folder: string, version: '2' | '3', dir: string): void => {
  const python = '"' + path.join(dir, 'python.exe') + '"';
  shim(folder, 'python' + version, python);
  shim(folder, 'pip' + version, python + ' -m pip');
};

export const setupPython = async (env: ToolEnv, config: Toolchains['python'], versions: ToolVersions): Promise<void> => {
  if (dryRun) { log('(dry run) would provision Python ' + versions.python.spec + (config.python2 ? ' and Python 2.7' : '')); return; }
  const py3 = await installPython('python', versions.python.spec);
  const shims = shimDir(py3);
  shimPair(shims, '3', py3);
  env.prepend.push(py3, path.join(py3, 'Scripts'), shims);
  env.vars.PYTHONIOENCODING = 'utf-8';
  env.summary.push('python: ' + path.basename(py3).replace('python-', '') + ' (from ' + versions.python.source + ')');
  if (!config.python2) return;
  const py2 = await installPython('python2', '2.7');
  shimPair(shims, '2', py2);
  env.summary.push('python2: ' + path.basename(py2).replace('python2-', ''));
};
