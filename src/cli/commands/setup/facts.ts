// What `sandbox setup` learns about this PC: the Windows edition, CPU virtualization and the Windows Sandbox feature.
import os from 'node:os';
import _ from 'lodash';
import { z } from 'zod';
import { freeBytesAt } from '../../../core/disk.js';
import { captureOutput, fileExists } from '../../../core/util/index.js';
import { SYSTEM, system32 } from '../../../shared/system.js';

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

/** `reg query <key>` output to { valueName: data }. */
export const parseRegQuery = (text: string): Record<string, string> =>
  Object.fromEntries(
    _.compact(
      text
        .split(/\r?\n/)
        .map((line) => /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line)?.slice(1, 3) as [string, string] | undefined),
    ),
  );

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

const Probe = z
  .object({
    virtualizationFirmware: z.boolean().nullable(),
    hypervisorPresent: z.boolean().nullable(),
    installState: z.number().nullable(),
  })
  .partial();

export const parseProbe = (text: string): z.infer<typeof Probe> => {
  try {
    return Probe.parse(JSON.parse(_.last(text.trim().split(/\r?\n/)) ?? ''));
  } catch {
    return {};
  }
};

export const gatherFacts = (storageRoot: string): MachineFacts => {
  const reg = parseRegQuery(
    captureOutput(SYSTEM.reg(), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion']),
  );
  const probe = parseProbe(captureOutput(SYSTEM.powershell(), ['-NoProfile', '-NonInteractive', '-Command', PROBE]));
  // DISM knows about a pending restart but needs admin rights; the CIM state works for everyone.
  const dism = parseDismState(
    captureOutput(SYSTEM.dism(), ['/English', '/Online', '/Get-FeatureInfo', '/FeatureName:' + FEATURE]),
  );
  return {
    edition: reg.EditionID ?? null,
    build: Number(reg.CurrentBuildNumber ?? reg.CurrentBuild) || null,
    feature: dism === 'unknown' ? featureFromInstallState(probe.installState) : dism,
    sandboxExe: fileExists(system32('WindowsSandbox.exe')),
    virtualizationFirmware: probe.virtualizationFirmware ?? null,
    hypervisorPresent: probe.hypervisorPresent ?? null,
    totalRamBytes: os.totalmem(),
    freeDiskBytes: freeBytesAt(storageRoot),
    storageRoot,
    nodeVersion: process.version,
  };
};
