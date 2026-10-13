// .NET: the SDK (dotnet-install.ps1), .NET Framework reference assemblies for old-style projects, and .NET Framework 3.5.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Toolchains } from '../../../core/types.js';
import { downloader, fetchJson } from '../../../shared/download/index.js';
import { readJsonFile, writeJsonAtomic } from '../../../shared/io/json.js';
import { safeRemove } from '../../../shared/io/safe-remove.js';
import { SYSTEM } from '../../../shared/system.js';
import { dataDir, dryRun } from '../../runtime/paths.js';
import { execAsync, execOutput } from '../../runtime/process.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { log, warn } from '../../runtime/log.js';
import { errMsg } from '../../../core/util/errors.js';
import { projectWorkspace } from '../../runtime/project-context.js';
import { downloadFile, installOnce } from '../install.js';
import { tool, type ToolEnv } from '../tool-env.js';

/** tools\dotnet\.agent-sandbox-installed.json: which install keys (channel:8.0, global.json:...) already ran. */
const DotnetMarker = z.record(z.string(), z.boolean());

/** .NET SDK channels from config plus whatever the workspace's global.json pins. Installs are remembered in a marker. */
export const setupDotnet = async (env: ToolEnv, config: Toolchains['dotnet'], refresh: boolean): Promise<void> => {
  const root = tool('dotnet');
  const marker = path.join(root, '.agent-sandbox-installed.json');
  const script = tool('dotnet-install.ps1');
  if (dryRun) {
    log('(dry run) would provision .NET SDK channels ' + config.channels.join(', '));
    return;
  }
  // A corrupt or hand-edited marker just means "nothing recorded yet" (the installs are idempotent).
  const recorded = DotnetMarker.safeParse(exists(marker) && !refresh ? readJsonFile<unknown>(marker) : {});
  const done: Record<string, boolean> = recorded.success ? recorded.data : {};
  const globalJson = path.join(projectWorkspace(), 'global.json');
  const installs: [string, string[]][] = [
    ...config.channels.map((c): [string, string[]] => ['channel:' + c, ['-Channel', c]]),
    ...(exists(globalJson)
      ? [
          ['global.json:' + fs.readFileSync(globalJson, 'utf8').replace(/\s+/g, ''), ['-JSonFile', globalJson]] as [
            string,
            string[],
          ],
        ]
      : []),
  ];
  for (const [key, args] of installs.filter(([k]) => !done[k])) {
    // Fetched every time something is installed (it is small): an interrupted earlier download must not be run.
    await downloadFile('https://dot.net/v1/dotnet-install.ps1', script);
    log(
      'Installing the .NET SDK ' +
        (key.startsWith('channel:') ? key.slice(8) : 'pinned in global.json') +
        ' (~250 MB once) ...',
    );
    await execAsync(SYSTEM.powershell(), [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      ...args,
      '-InstallDir',
      root,
      '-NoPath',
    ]);
    done[key] = true;
    writeJsonAtomic(marker, done);
  }
  const home = mkdirp(tool('dotnet-home'));
  Object.assign(env.vars, {
    DOTNET_ROOT: root,
    DOTNET_CLI_HOME: home,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    NUGET_PACKAGES: tool('nuget', 'packages'),
  });
  env.prepend.push(root, path.join(home, '.dotnet', 'tools'));
  env.summary.push(
    'dotnet: ' +
      execOutput(path.join(root, 'dotnet.exe'), ['--list-sdks'])
        .split(/\r?\n/)
        .map((l) => l.split(' ')[0])
        .filter(Boolean)
        .join(', '),
  );
  const dotnet = path.join(root, 'dotnet.exe');
  const dotnetEnv = { env: { ...process.env, ...env.vars, PATH: root + path.delimiter + (process.env.PATH ?? '') } };
  await installOnce(env, 'dotnet workload', config.workloads, (w) =>
    execAsync(dotnet, ['workload', 'install', w, '--skip-manifest-update'], dotnetEnv),
  );
  await installOnce(env, 'dotnet tool', config.tools, (t) =>
    execAsync(dotnet, ['tool', 'install', '--global', t], dotnetEnv),
  );
  await setupFrameworkReferences(env, config.frameworkTargets);
  if (config.netfx35) await setupNetFx35(env);
};

/**
 * .NET Framework reference assemblies (the "targeting packs" Visual Studio would install) from NuGet, so net4x projects,
 * old-style .csproj included, build with the SDK's MSBuild. MSBuild reads TargetFrameworkRootPath from the environment.
 * Running .NET Framework 4.8 apps needs nothing: Windows ships it.
 */
const setupFrameworkReferences = async (env: ToolEnv, targets: string[]): Promise<void> => {
  if (!targets.length) return;
  const root = tool('netfx-references');
  for (const target of targets) {
    const id = 'microsoft.netframework.referenceassemblies.' + target.toLowerCase();
    const marker = path.join(root, '.installed-' + target.toLowerCase());
    if (exists(marker)) continue;
    const staging = tool('netfx-references-' + target.toLowerCase());
    try {
      const { versions } = await fetchJson<{ versions: string[] }>(
        'https://api.nuget.org/v3-flatcontainer/' + id + '/index.json',
      );
      const version = versions.filter((v) => /^\d+(\.\d+)*$/.test(v)).pop();
      if (!version) throw new Error('no stable version of ' + id);
      log('Downloading the .NET Framework ' + target + ' reference assemblies (~30 MB once) ...');
      await downloader.archive(
        'https://api.nuget.org/v3-flatcontainer/' + id + '/' + version + '/' + id + '.' + version + '.nupkg',
        staging,
        { fileName: id + '.zip' },
      );
      fs.cpSync(path.join(staging, 'build', '.NETFramework'), path.join(root, '.NETFramework'), { recursive: true });
      fs.writeFileSync(marker, version);
    } catch (e) {
      warn(
        '.NET Framework ' +
          target +
          ' reference assemblies could not be installed (projects targeting it will not build): ' +
          errMsg(e),
      );
    } finally {
      safeRemove(staging, dataDir);
    }
  }
  if (!exists(path.join(root, '.NETFramework'))) return;
  env.vars.TargetFrameworkRootPath = root + path.sep;
  env.summary.push('.NET Framework targeting: ' + fs.readdirSync(path.join(root, '.NETFramework')).join(', '));
};

/** .NET Framework 3.5 is a Windows feature the sandbox image lacks; DISM fetches it from Windows Update on every boot. */
const setupNetFx35 = async (env: ToolEnv): Promise<void> => {
  if (
    execOutput(SYSTEM.reg(), [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v3.5',
      '/v',
      'Install',
    ]).includes('0x1')
  ) {
    env.summary.push('.NET Framework 3.5: on');
    return;
  }
  log('Enabling .NET Framework 3.5 (downloads from Windows Update, a few minutes) ...');
  try {
    await execAsync(
      SYSTEM.dism(),
      ['/Online', '/Enable-Feature', '/FeatureName:NetFx3', '/All', '/NoRestart', '/Quiet'],
      { stdio: 'ignore' },
    );
    env.summary.push('.NET Framework 3.5: on');
  } catch (e) {
    warn('.NET Framework 3.5 could not be enabled: ' + errMsg(e));
    env.summary.push('.NET Framework 3.5: FAILED');
  }
};
