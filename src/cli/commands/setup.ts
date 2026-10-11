// `sandbox setup`: checks this PC can run Windows Sandbox and offers to turn the feature on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import _ from 'lodash';
import { z } from 'zod';
import { askYesNo } from '../../core/workspace.js';
import { fail, fileExists, isWin } from '../../core/util.js';
import { SYSTEM, system32 } from '../../shared/system.js';
import { table, type Context } from './context.js';

export type CheckStatus = 'ok' | 'warn' | 'action';
export interface Check { name: string; status: CheckStatus; detail: string }
export type FeatureState = 'enabled' | 'pending' | 'disabled' | 'unknown';
export type EditionSupport = 'supported' | 'home' | 'unsupported' | 'unknown';

export interface MachineFacts {
  edition: string | null;
  build: number | null;
  feature: FeatureState;
  /** WindowsSandbox.exe exists (it appears only after the restart that follows enabling the feature). */
  sandboxExe: boolean;
  virtualizationFirmware: boolean | null;
  hypervisorPresent: boolean | null;
  totalRamBytes: number;
  freeDiskBytes: number | null;
  storageRoot: string;
  nodeVersion: string;
}

const FEATURE = 'Containers-DisposableClientVM';
export const ENABLE_COMMAND = 'Enable-WindowsOptionalFeature -Online -FeatureName ' + FEATURE + ' -All -NoRestart';
const GB = 1024 ** 3;

/** `reg query <key>` output to { valueName: data }. */
export const parseRegQuery = (text: string): Record<string, string> =>
  Object.fromEntries(_.compact(text.split(/\r?\n/).map((line) => /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line)?.slice(1, 3) as [string, string] | undefined)));

/** Windows Sandbox needs Pro, Enterprise or Education (build 18305+); Home ("Core*") and Server cannot run it. */
export const editionSupport = (edition: string | null): EditionSupport => {
  if (!edition) return 'unknown';
  if (/^Core/i.test(edition)) return 'home';
  if (/^Server/i.test(edition)) return 'unsupported';
  return /^(Professional|Enterprise|Education|IoTEnterprise)/i.test(edition) ? 'supported' : 'unknown';
};

/** The "State : ..." line of `Dism /Get-FeatureInfo` (English output only; anything else is unknown). */
export const parseDismState = (text: string): FeatureState => {
  const state = /^State\s*:\s*(.+?)\s*$/im.exec(text)?.[1].toLowerCase() ?? '';
  if (state === 'enabled') return 'enabled';
  if (state.includes('pending')) return 'pending';
  return state.startsWith('disabled') ? 'disabled' : 'unknown';
};

/** Win32_OptionalFeature.InstallState: 1 enabled, 2 disabled, 3 absent. */
export const featureFromInstallState = (state: number | null | undefined): FeatureState =>
  state === 1 ? 'enabled' : state === 2 || state === 3 ? 'disabled' : 'unknown';

export const nodeMajor = (version: string): number => Number(/^v?(\d+)/.exec(version.trim())?.[1] ?? 0);

/** Offer to enable the feature only when it is off and this edition can have it. */
export const canEnableFeature = (f: MachineFacts): boolean =>
  f.feature !== 'enabled' && f.feature !== 'pending' && !f.sandboxExe && ['supported', 'unknown'].includes(editionSupport(f.edition));

const formatGb =(bytes: number): string => (bytes / GB).toFixed(1) + ' GB';

/** Turns what we learnt about the PC into the checklist (pure, so it can be tested). */
export const buildChecks = (f: MachineFacts): Check[] => {
  const support = editionSupport(f.edition);
  const edition = (f.edition ?? 'unknown edition') + (f.build ? ', build ' + f.build : '');
  const virt = f.hypervisorPresent || f.virtualizationFirmware;
  const featureReady = f.feature === 'enabled' && f.sandboxExe;
  return [
    support === 'supported' && (f.build ?? 18305) >= 18305 ? { name: 'Windows edition', status: 'ok', detail: edition }
      : support === 'home' ? { name: 'Windows edition', status: 'action', detail: edition + ': Windows Home cannot run Windows Sandbox. Upgrade to Pro (Settings > System > Activation).' }
      : support === 'unsupported' ? { name: 'Windows edition', status: 'action', detail: edition + ': Windows Sandbox needs Windows 10/11 Pro, Enterprise or Education.' }
      : support === 'supported' ? { name: 'Windows edition', status: 'action', detail: edition + ': too old; Windows Sandbox needs Windows 10 version 1903 or newer.' }
      : { name: 'Windows edition', status: 'warn', detail: edition + ': not sure this edition has Windows Sandbox (it needs Pro, Enterprise or Education).' },
    virt ? { name: 'CPU virtualization', status: 'ok', detail: f.hypervisorPresent ? 'on (hypervisor running)' : 'on' }
      : virt === false ? { name: 'CPU virtualization', status: 'action', detail: 'off. Turn on Intel VT-x / AMD-V (SVM) in your PC\'s BIOS/UEFI settings, then run this again.' }
      : { name: 'CPU virtualization', status: 'warn', detail: 'could not tell; if Windows Sandbox will not start, turn on VT-x / AMD-V in the BIOS/UEFI.' },
    featureReady ? { name: 'Windows Sandbox feature', status: 'ok', detail: 'enabled' }
      : f.feature === 'pending' || (f.feature === 'enabled' && !f.sandboxExe) ? { name: 'Windows Sandbox feature', status: 'action', detail: 'enabled, but Windows needs a restart to finish.' }
      : f.sandboxExe ? { name: 'Windows Sandbox feature', status: 'ok', detail: 'installed' }
      : { name: 'Windows Sandbox feature', status: 'action', detail: 'not enabled. In an admin PowerShell: ' + ENABLE_COMMAND + ', then restart.' },
    { name: 'Memory', status: f.totalRamBytes < 4 * GB ? 'action' : f.totalRamBytes < 8 * GB ? 'warn' : 'ok', detail: formatGb(f.totalRamBytes) + (f.totalRamBytes < 4 * GB ? ': Windows Sandbox needs at least 4 GB.' : f.totalRamBytes < 8 * GB ? ': works, but 8 GB or more is recommended.' : '') },
    f.freeDiskBytes === null ? { name: 'Free disk', status: 'warn', detail: 'could not check the drive of ' + f.storageRoot }
      : { name: 'Free disk', status: f.freeDiskBytes < 5 * GB ? 'action' : f.freeDiskBytes < 20 * GB ? 'warn' : 'ok', detail: formatGb(f.freeDiskBytes) + ' free for ' + f.storageRoot + (f.freeDiskBytes < 5 * GB ? ': free up space (toolchains need several GB).' : f.freeDiskBytes < 20 * GB ? ': getting low; toolchains and caches can use several GB.' : '') },
    nodeMajor(f.nodeVersion) >= 20 ? { name: 'Node.js', status: 'ok', detail: f.nodeVersion } : { name: 'Node.js', status: 'action', detail: f.nodeVersion + ': needs 20 or newer (winget install OpenJS.NodeJS.LTS).' },
  ];
};

// Fixed script (no outside data): CPU/hypervisor facts and the feature state, readable without admin rights.
const PROBE = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$cpu = @(Get-CimInstance Win32_Processor)',
  '$cs = Get-CimInstance Win32_ComputerSystem',
  '$f = Get-CimInstance Win32_OptionalFeature -Filter "Name=\'' + FEATURE + '\'"',
  '$v = $null; if ($cpu.Count) { $v = [bool]($cpu | Where-Object { $_.VirtualizationFirmwareEnabled }) }',
  '$h = $null; if ($cs) { $h = [bool]$cs.HypervisorPresent }',
  '$s = $null; if ($f) { $s = [int]$f.InstallState }',
  '@{ virtualizationFirmware = $v; hypervisorPresent = $h; installState = $s } | ConvertTo-Json -Compress',
].join('; ');

const Probe = z.object({ virtualizationFirmware: z.boolean().nullable(), hypervisorPresent: z.boolean().nullable(), installState: z.number().nullable() }).partial();

export const parseProbe = (text: string): z.infer<typeof Probe> => {
  try { return Probe.parse(JSON.parse(_.last(text.trim().split(/\r?\n/)) ?? '')); } catch { return {}; }
};

const run = (exe: string, args: string[]): string => {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return r.status === 0 ? r.stdout : '';
};

const freeDisk = (dir: string): number | null => {
  let at = path.resolve(dir);
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  try { const s = fs.statfsSync(at); return s.bavail * s.bsize; } catch { return null; }
};

const gatherFacts = (storageRoot: string): MachineFacts => {
  const reg = parseRegQuery(run(SYSTEM.reg(), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion']));
  const probe = parseProbe(run(SYSTEM.powershell(), ['-NoProfile', '-NonInteractive', '-Command', PROBE]));
  // DISM knows about a pending restart but needs admin rights; the CIM state works for everyone.
  const dism = parseDismState(run(SYSTEM.dism(), ['/English', '/Online', '/Get-FeatureInfo', '/FeatureName:' + FEATURE]));
  return {
    edition: reg.EditionID ?? null,
    build: Number(reg.CurrentBuildNumber ?? reg.CurrentBuild) || null,
    feature: dism === 'unknown' ? featureFromInstallState(probe.installState) : dism,
    sandboxExe: fileExists(system32('WindowsSandbox.exe')),
    virtualizationFirmware: probe.virtualizationFirmware ?? null,
    hypervisorPresent: probe.hypervisorPresent ?? null,
    totalRamBytes: os.totalmem(),
    freeDiskBytes: freeDisk(storageRoot),
    storageRoot,
    nodeVersion: process.version,
  };
};

const LABEL: Record<CheckStatus, string> = { ok: '\x1b[32mOK\x1b[0m', warn: '\x1b[33mWARNING\x1b[0m', action: '\x1b[31mACTION NEEDED\x1b[0m' };
const print = (checks: Check[]): void => table(checks.map((c) => [LABEL[c.status], c.name, c.detail]));

/** Runs the enable command in an elevated PowerShell (Windows asks for permission); true if it worked. */
const enableFeature = (): boolean => {
  const inner = "'-NoProfile','-Command','" + ENABLE_COMMAND + " | Out-Null'";
  const outer = "try { $p = Start-Process -FilePath '" + SYSTEM.powershell() + "' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList " + inner + '; exit $p.ExitCode } catch { exit 1 }';
  return spawnSync(SYSTEM.powershell(), ['-NoProfile', '-NonInteractive', '-Command', outer], { stdio: 'inherit' }).status === 0;
};

export const setup = async (ctx: Context): Promise<number> => {
  if (!isWin) fail('Windows Sandbox only runs on Windows.', 'Run sandbox setup on a Windows 10/11 Pro, Enterprise or Education PC.');
  console.log('Checking this PC for Windows Sandbox...\n');
  const facts = gatherFacts(ctx.storageRoot);
  let checks = buildChecks(facts);
  print(checks);
  if (canEnableFeature(facts)) {
    console.log('');
    if (await askYesNo('Turn on Windows Sandbox now? Windows will ask for admin permission.')) {
      console.log('Enabling Windows Sandbox (this can take a minute)...');
      if (!enableFeature()) fail('Windows Sandbox could not be enabled (or the admin prompt was declined).', 'In an admin PowerShell run: ' + ENABLE_COMMAND + ', then restart Windows.');
      console.log('Done. Restart Windows to finish, then run sandbox setup again.\n');
      checks = buildChecks(gatherFacts(ctx.storageRoot));
      print(checks);
    } else console.log('To do it yourself, in an admin PowerShell run:\n  ' + ENABLE_COMMAND + '\nthen restart Windows.');
  }
  const todo = checks.filter((c) => c.status === 'action').length;
  console.log('\n' + (todo ? todo + ' thing(s) to fix before the sandbox can start (see ACTION NEEDED above).' : 'This PC is ready. cd into a project and run claude-sbx (or sandbox for no agent).'));
  return todo ? 1 : 0;
};
