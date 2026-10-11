// MSVC (cl, link) and the Windows SDK without an installer, the way mmozeiko's portable-msvc.py does it: packages
// from Microsoft's Visual Studio channel manifest (each payload checked against the manifest's sha256), the compiler
// unpacked from its .vsix, the SDK from its .msi files with `msiexec /a`. Laid out like a Build Tools install, with
// vcvars64.bat and a vswhere that points at it, so CMake, cargo (msvc host), node-gyp and vcvars-based scripts work.
// Use is governed by the Visual Studio licence terms: it only installs with toolchains.msvc.acceptLicense.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Toolchains } from '../../core/types.js';
import { writeJsonAtomic } from '../../shared/rundir.js';
import { download, extractArchive, fetchJson } from '../../shared/download.js';
import { safeRemove } from '../../shared/safe-remove.js';
import { system32 } from '../../shared/system.js';
import { dryRun, errMsg, execAsync, exists, log, mkdirp, warn } from '../env.js';
import { ensureCompiled } from '../ptyhost.js';
import { tool, type ToolEnv } from './common.js';
import { msiCabs, pickMsvcVersion, pickWindowsSdk } from './versions.js';

interface Payload { fileName: string; url: string; sha256: string; size: number }
interface Package { id: string; version: string; language?: string; payloads?: Payload[]; dependencies?: Record<string, unknown> }
interface Manifest { packages: Package[] }

const CHANNEL = 'https://aka.ms/vs/17/release/channel';
const ROOT = tool('msvc');
const MANIFEST_DAY_MS = 24 * 60 * 60 * 1000;
/** Where build tools look for vswhere (local to the sandbox, so it is written each boot). */
const VSWHERE_DIR = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer');

/** The VS manifest (~18 MB), cached for a day. */
const manifest = async (): Promise<Manifest> => {
  const cached = path.join(ROOT, '.manifest.json');
  if (exists(cached) && Date.now() - fs.statSync(cached).mtimeMs < MANIFEST_DAY_MS) {
    // A download cut short leaves unreadable JSON: fetch it again instead of failing until the day is over.
    try { return JSON.parse(fs.readFileSync(cached, 'utf8')) as Manifest; } catch { /* downloaded again below */ }
  }
  const channel = await fetchJson<{ channelItems: { id: string; payloads?: Payload[] }[] }>(CHANNEL);
  const item = channel.channelItems.find((i) => i.id === 'Microsoft.VisualStudio.Manifests.VisualStudio')?.payloads?.[0];
  if (!item) throw new Error('the Visual Studio channel has no package manifest');
  mkdirp(ROOT);
  // The channel's sha256 for the manifest is not the file's hash (portable-msvc.py does not check it either); the
  // manifest comes over HTTPS from Microsoft, and every package payload it lists IS checked against its own sha256.
  await download(item.url, cached);
  return JSON.parse(fs.readFileSync(cached, 'utf8')) as Manifest;
};

/** The compiler's packages (host x64, target x64): tools, resources, CRT headers/libs, ASAN/PGO headers, DIA SDK. */
const MSVC_PARTS = ['tools.hostx64.targetx64.base', 'tools.hostx64.targetx64.res.base', 'crt.headers.base', 'crt.x64.desktop.base', 'crt.x64.store.base', 'crt.source.base', 'asan.headers.base', 'pgo.headers.base'];
/** The SDK's .msi files (Desktop + UCRT + Store headers/libs/tools for x64), as in portable-msvc.py. */
const SDK_MSIS = [
  'Windows SDK for Windows Store Apps Tools-x86_en-us.msi', 'Windows SDK for Windows Store Apps Headers-x86_en-us.msi',
  'Windows SDK for Windows Store Apps Headers OnecoreUap-x86_en-us.msi', 'Windows SDK for Windows Store Apps Libs-x86_en-us.msi',
  'Universal CRT Headers Libraries and Sources-x86_en-us.msi', 'Windows SDK Desktop Headers x86-x86_en-us.msi',
  'Windows SDK Desktop Headers x64-x86_en-us.msi', 'Windows SDK Desktop Libs x64-x86_en-us.msi', 'Windows SDK Desktop Tools x64-x86_en-us.msi',
];

/** .vsix contents are percent-encoded file names under Contents/; unpack them into the root, names decoded. */
const unpackVsix = async (vsix: string, work: string): Promise<void> => {
  const out = mkdirp(path.join(work, 'vsix-' + path.basename(vsix)));
  await extractArchive(vsix, out, ['Contents']);
  const decode = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      let name = entry.name;
      try { if (name.includes('%')) name = decodeURIComponent(name); } catch { /* not percent-encoded after all */ }
      const to = path.join(dir, name);
      if (to !== from) fs.renameSync(from, to);
      if (entry.isDirectory()) decode(to);
    }
  };
  decode(out);
  fs.cpSync(path.join(out, 'Contents'), ROOT, { recursive: true, force: true });
  safeRemove(out, work);
};

const install = async (config: Toolchains['msvc']): Promise<{ msvc: string; sdk: string }> => {
  const m = await manifest();
  const byId = new Map<string, Package[]>();
  for (const p of m.packages) byId.set(p.id.toLowerCase(), [...(byId.get(p.id.toLowerCase()) ?? []), p]);
  const pick = (id: string): Package | undefined => byId.get(id.toLowerCase())?.find((p) => !p.language || p.language === 'en-US');
  const ids = [...byId.keys()];
  const version = pickMsvcVersion(ids, config.msvcVersion);
  if (!version) throw new Error('no MSVC ' + config.msvcVersion + ' in the Visual Studio manifest');
  const sdk = pickWindowsSdk(ids, config.sdkVersion);
  if (!sdk) throw new Error('no Windows SDK ' + config.sdkVersion + ' in the Visual Studio manifest');
  const work = mkdirp(path.join(ROOT, '.download'));
  const fetchPayload = async (p: Payload): Promise<string> => {
    const file = path.join(work, path.basename(p.fileName.replace(/\\/g, '/')));
    if (!exists(file)) await download(p.url, file, p.sha256);
    return file;
  };
  log('Downloading the MSVC ' + version + ' compiler and C/C++ libraries ...');
  for (const part of MSVC_PARTS) {
    const p = pick('microsoft.vc.' + version + '.' + part);
    if (!p) { if (part.startsWith('tools') || part.startsWith('crt.headers') || part.startsWith('crt.x64.desktop')) throw new Error('MSVC ' + version + ' has no ' + part); continue; }
    for (const payload of p.payloads ?? []) await unpackVsix(await fetchPayload(payload), work);
  }
  const dia = pick('microsoft.visualcpp.dia.sdk');
  for (const payload of dia?.payloads ?? []) await unpackVsix(await fetchPayload(payload), work);
  // The SDK component depends on the package that holds the .msi/.cab payloads (e.g. Win11SDK_10.0.26100).
  const sdkPackage = pick(Object.keys(pick(sdk.componentId)?.dependencies ?? {})[0] ?? '');
  if (!sdkPackage?.payloads) throw new Error('the Windows SDK ' + sdk.build + ' package has no payloads');
  log('Downloading the Windows SDK ' + sdk.build + ' (headers, libraries; the biggest part) ...');
  const payload = (name: string): Payload | undefined => sdkPackage.payloads!.find((p) => p.fileName.toLowerCase() === ('installers\\' + name).toLowerCase());
  const msis: string[] = [];
  for (const name of SDK_MSIS) {
    const p = payload(name);
    if (!p) throw new Error('the Windows SDK package has no ' + name);
    const file = await fetchPayload(p);
    msis.push(file);
    for (const cab of msiCabs(fs.readFileSync(file))) { const c = payload(cab); if (c) await fetchPayload(c); }
  }
  log('Unpacking the Windows SDK (a few minutes) ...');
  for (const msi of msis) {
    // An administrative install only unpacks files; its verbose log explains a failure (e.g. a path over 260 characters).
    const logFile = msi + '.log';
    try { await execAsync(system32('msiexec.exe'), ['/a', msi, '/quiet', '/qn', 'TARGETDIR=' + ROOT, '/l*v', logFile], { stdio: 'ignore' }); } catch (e) {
      const lines = exists(logFile) ? fs.readFileSync(logFile, 'utf16le').split(/\r?\n/).filter((l) => /error|return value 3|failed/i.test(l)).slice(-4).join(' | ') : '';
      throw new Error(path.basename(msi) + ' did not unpack: ' + (e instanceof Error ? e.message : String(e)) + (lines ? ' (' + lines.slice(0, 600) + ')' : ''));
    }
  }
  // msiexec /a also copies every .msi into the target; they are not needed.
  for (const name of fs.readdirSync(ROOT).filter((n) => n.toLowerCase().endsWith('.msi'))) fs.rmSync(path.join(ROOT, name), { force: true });
  safeRemove(work, ROOT);
  const sdkVersion = fs.readdirSync(path.join(ROOT, 'Windows Kits', '10', 'Include')).filter((d) => d.startsWith('10.0.' + sdk.build)).sort().pop();
  if (!sdkVersion) throw new Error('the Windows SDK did not unpack (no Include\\10.0.' + sdk.build + '.*)');
  // The tools folder is named after the toolset (14.44.35207), not the package version (14.44.17.14).
  const toolsRoot = path.join(ROOT, 'VC', 'Tools', 'MSVC');
  const tools = fs.readdirSync(toolsRoot).filter((d) => exists(path.join(toolsRoot, d, 'bin', 'Hostx64', 'x64', 'cl.exe'))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  if (!tools) throw new Error('MSVC ' + version + ' did not unpack (no cl.exe under VC\\Tools\\MSVC)');
  return { msvc: tools, sdk: sdkVersion };
};

/** Variables vcvars64.bat would set for this tree (host x64, target x64). */
export const vcvars = (root: string, msvc: string, sdk: string): { vars: Record<string, string>; path: string[] } => {
  const vc = path.join(root, 'VC', 'Tools', 'MSVC', msvc);
  const kits = path.join(root, 'Windows Kits', '10');
  const inc = (...p: string[]): string => path.join(kits, 'Include', sdk, ...p);
  const lib = (...p: string[]): string => path.join(kits, 'Lib', sdk, ...p);
  return {
    vars: {
      VSINSTALLDIR: root + '\\', VCINSTALLDIR: path.join(root, 'VC') + '\\', VCToolsInstallDir: vc + '\\', VCToolsVersion: msvc, VisualStudioVersion: '17.0',
      WindowsSdkDir: kits + '\\', WindowsSDKVersion: sdk + '\\', WindowsSDKLibVersion: sdk + '\\', UniversalCRTSdkDir: kits + '\\', UCRTVersion: sdk,
      VSCMD_ARG_HOST_ARCH: 'x64', VSCMD_ARG_TGT_ARCH: 'x64', Platform: 'x64',
      INCLUDE: [path.join(vc, 'include'), inc('ucrt'), inc('shared'), inc('um'), inc('winrt'), inc('cppwinrt')].join(';'),
      LIB: [path.join(vc, 'lib', 'x64'), lib('ucrt', 'x64'), lib('um', 'x64')].join(';'),
      LIBPATH: [path.join(vc, 'lib', 'x64'), path.join(vc, 'lib', 'x86', 'store', 'references')].join(';'),
    },
    path: [path.join(vc, 'bin', 'Hostx64', 'x64'), path.join(kits, 'bin', sdk, 'x64')],
  };
};

/** vcvars64.bat / vcvarsall.bat in the usual place, for scripts that `call` them. */
const writeVcvars = (env: ReturnType<typeof vcvars>): void => {
  const dir = mkdirp(path.join(ROOT, 'VC', 'Auxiliary', 'Build'));
  const lines = ['@echo off', 'rem Written by Windows Development Sandbox for its portable MSVC (host x64, target x64).',
    ...Object.entries(env.vars).map(([k, v]) => 'set "' + k + '=' + v + '"'), 'set "PATH=' + env.path.join(';') + ';%PATH%"', 'exit /b 0'];
  fs.writeFileSync(path.join(dir, 'vcvars64.bat'), lines.join('\r\n') + '\r\n');
  fs.writeFileSync(path.join(dir, 'vcvarsall.bat'), ['@echo off', 'rem Only x64 (amd64) is installed.', 'call "%~dp0vcvars64.bat"', 'exit /b %errorlevel%'].join('\r\n') + '\r\n');
};

/** vswhere.exe where Visual Studio's installer would put it, answering with this tree. */
const installVswhere = (msvc: string): void => {
  mkdirp(VSWHERE_DIR);
  fs.copyFileSync(ensureCompiled('vswhere'), path.join(VSWHERE_DIR, 'vswhere.exe'));
  const [major, minor] = msvc.split('.').slice(2);
  fs.writeFileSync(path.join(VSWHERE_DIR, 'vswhere.json'), JSON.stringify({ installationPath: ROOT, installationVersion: '17.' + (minor ?? '0') + '.0.' + (major ?? '0') }));
};

/**
 * cl.exe and link.exe start vctip.exe (Visual Studio's telemetry uploader), which lingers after the build and keeps the
 * folder locked, so `sandbox repair` / `data clean` could not delete tools\msvc. Neither VSCMD_SKIP_SENDTELEMETRY nor
 * the TurnOffSwitch registry value stops it; without the file the compiler simply skips it. Nothing else needs it.
 */
const removeTelemetry = (msvc: string): void => {
  const vctip = path.join(ROOT, 'VC', 'Tools', 'MSVC', msvc, 'bin', 'Hostx64', 'x64', 'vctip.exe');
  try { fs.rmSync(vctip, { force: true }); } catch (e) { warn('Could not remove MSVC\'s telemetry helper (vctip.exe); it may keep tools\\msvc locked: ' + errMsg(e)); }
};

const Installed = z.object({ msvc: z.string().min(1), sdk: z.string().min(1), want: z.string() });
const MARKER = path.join(ROOT, '.installed.json');
/** What the last finished install recorded; null for a missing, unreadable or half-written marker. */
const readInstalled = (): z.infer<typeof Installed> | null => {
  try { return Installed.safeParse(JSON.parse(fs.readFileSync(MARKER, 'utf8'))).data ?? null; } catch { return null; }
};
const hasCompiler = (msvc: string): boolean => exists(path.join(ROOT, 'VC', 'Tools', 'MSVC', msvc, 'bin', 'Hostx64', 'x64', 'cl.exe'));

/** The vcvars environment of an installed tree (for steps that run before the agent's environment exists). */
export const installedMsvcEnv = (): ReturnType<typeof vcvars> | null => {
  const done = readInstalled();
  return done && hasCompiler(done.msvc) ? vcvars(ROOT, done.msvc, done.sdk) : null;
};

export const setupMsvc = async (env: ToolEnv, config: Toolchains['msvc']): Promise<void> => {
  if (!config.acceptLicense) {
    throw new Error('MSVC is installed only with toolchains.msvc.acceptLicense = true: its use is governed by the Visual Studio licence terms (https://visualstudio.microsoft.com/license-terms/), which need a Visual Studio licence');
  }
  if (dryRun) { log('(dry run) would provision MSVC ' + config.msvcVersion + ' and Windows SDK ' + config.sdkVersion); return; }
  const want = config.msvcVersion + '/' + config.sdkVersion;
  let done = readInstalled();
  if (!done || done.want !== want || !hasCompiler(done.msvc)) {
    log('Installing MSVC and the Windows SDK (~1-2 GB, once; licence accepted in toolchains.msvc.acceptLicense) ...');
    // A previous attempt's verified downloads (.download) are kept; everything it unpacked is redone.
    if (exists(ROOT)) for (const name of fs.readdirSync(ROOT).filter((n) => n !== '.manifest.json' && n !== '.download')) safeRemove(path.join(ROOT, name), ROOT);
    const installed = await install(config);
    done = { ...installed, want };
    // Written last and atomically: without it (an interrupted install) the next boot starts over.
    writeJsonAtomic(MARKER, done);
  }
  removeTelemetry(done.msvc);
  const vc = vcvars(ROOT, done.msvc, done.sdk);
  writeVcvars(vc);
  installVswhere(done.msvc);
  Object.assign(env.vars, vc.vars);
  env.prepend.push(...vc.path);
  env.summary.push('msvc: ' + done.msvc + ', Windows SDK ' + done.sdk + ' (cl, link; vcvars64.bat and vswhere work)');
};
