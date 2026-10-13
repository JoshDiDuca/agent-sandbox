// What makes the unpacked tree behave like a Build Tools install: the vcvars environment, vcvars64.bat, vswhere.
import fs from 'node:fs';
import path from 'node:path';
import { errMsg, mkdirp, warn } from '../../../env.js';
import { ensureCompiled } from '../../../helpers.js';
import { hostBin, ROOT } from './tree.js';

/** Where build tools look for vswhere (local to the sandbox, so it is written each boot). */
const VSWHERE_DIR = path.join(
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  'Microsoft Visual Studio',
  'Installer',
);

export interface VcEnv {
  vars: Record<string, string>;
  path: string[];
}

/** Variables vcvars64.bat would set for this tree (host x64, target x64). */
export const vcvars = (root: string, msvc: string, sdk: string): VcEnv => {
  const vc = path.join(root, 'VC', 'Tools', 'MSVC', msvc);
  const kits = path.join(root, 'Windows Kits', '10');
  const inc = (...p: string[]): string => path.join(kits, 'Include', sdk, ...p);
  const lib = (...p: string[]): string => path.join(kits, 'Lib', sdk, ...p);
  return {
    vars: {
      VSINSTALLDIR: root + '\\',
      VCINSTALLDIR: path.join(root, 'VC') + '\\',
      VCToolsInstallDir: vc + '\\',
      VCToolsVersion: msvc,
      VisualStudioVersion: '17.0',
      WindowsSdkDir: kits + '\\',
      WindowsSDKVersion: sdk + '\\',
      WindowsSDKLibVersion: sdk + '\\',
      UniversalCRTSdkDir: kits + '\\',
      UCRTVersion: sdk,
      VSCMD_ARG_HOST_ARCH: 'x64',
      VSCMD_ARG_TGT_ARCH: 'x64',
      Platform: 'x64',
      INCLUDE: [path.join(vc, 'include'), inc('ucrt'), inc('shared'), inc('um'), inc('winrt'), inc('cppwinrt')].join(
        ';',
      ),
      LIB: [path.join(vc, 'lib', 'x64'), lib('ucrt', 'x64'), lib('um', 'x64')].join(';'),
      LIBPATH: [path.join(vc, 'lib', 'x64'), path.join(vc, 'lib', 'x86', 'store', 'references')].join(';'),
    },
    path: [path.join(vc, 'bin', 'Hostx64', 'x64'), path.join(kits, 'bin', sdk, 'x64')],
  };
};

/** vcvars64.bat / vcvarsall.bat in the usual place, for scripts that `call` them. */
export const writeVcvars = (env: VcEnv): void => {
  const dir = mkdirp(path.join(ROOT, 'VC', 'Auxiliary', 'Build'));
  const lines = [
    '@echo off',
    'rem Written by Windows Development Sandbox for its portable MSVC (host x64, target x64).',
    ...Object.entries(env.vars).map(([k, v]) => 'set "' + k + '=' + v + '"'),
    'set "PATH=' + env.path.join(';') + ';%PATH%"',
    'exit /b 0',
  ];
  fs.writeFileSync(path.join(dir, 'vcvars64.bat'), lines.join('\r\n') + '\r\n');
  fs.writeFileSync(
    path.join(dir, 'vcvarsall.bat'),
    ['@echo off', 'rem Only x64 (amd64) is installed.', 'call "%~dp0vcvars64.bat"', 'exit /b %errorlevel%'].join(
      '\r\n',
    ) + '\r\n',
  );
};

/** vswhere.exe where Visual Studio's installer would put it, answering with this tree. */
export const installVswhere = (msvc: string): void => {
  mkdirp(VSWHERE_DIR);
  fs.copyFileSync(ensureCompiled('vswhere'), path.join(VSWHERE_DIR, 'vswhere.exe'));
  const [major, minor] = msvc.split('.').slice(2);
  fs.writeFileSync(
    path.join(VSWHERE_DIR, 'vswhere.json'),
    JSON.stringify({ installationPath: ROOT, installationVersion: '17.' + (minor ?? '0') + '.0.' + (major ?? '0') }),
  );
};

/**
 * cl.exe and link.exe start vctip.exe (Visual Studio's telemetry uploader), which lingers after the build and keeps the
 * folder locked, so `sandbox repair` / `data clean` could not delete tools\msvc. Neither VSCMD_SKIP_SENDTELEMETRY nor
 * the TurnOffSwitch registry value stops it; without the file the compiler simply skips it. Nothing else needs it.
 */
export const removeTelemetry = (msvc: string): void => {
  try {
    fs.rmSync(hostBin(msvc, 'vctip.exe'), { force: true });
  } catch (e) {
    warn("Could not remove MSVC's telemetry helper (vctip.exe); it may keep tools\\msvc locked: " + errMsg(e));
  }
};
