// Turns what `sandbox setup` learnt about the PC into a checklist. Pure, so it can be tested.
import { GB } from '../../../core/disk.js';
import { ENABLE_COMMAND, type EditionSupport, type MachineFacts } from './facts.js';

export type CheckStatus = 'ok' | 'warn' | 'action';
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Windows Sandbox needs Pro, Enterprise or Education (build 18305+); Home ("Core*") and Server cannot run it. */
export function editionSupport(edition: string | null): EditionSupport {
  if (!edition) return 'unknown';
  if (/^Core/i.test(edition)) return 'home';
  if (/^Server/i.test(edition)) return 'unsupported';
  return /^(Professional|Enterprise|Education|IoTEnterprise)/i.test(edition) ? 'supported' : 'unknown';
}

export function nodeMajor(version: string): number {
  return Number(/^v?(\d+)/.exec(version.trim())?.[1] ?? 0);
}

/** Offer to enable the feature only when it is off and this edition can have it. */
export function canEnableFeature(f: MachineFacts): boolean {
  return (
    f.feature !== 'enabled' &&
    f.feature !== 'pending' &&
    !f.sandboxExe &&
    ['supported', 'unknown'].includes(editionSupport(f.edition))
  );
}

function formatGb(bytes: number): string {
  return (bytes / GB).toFixed(1) + ' GB';
}

function check(name: string, status: CheckStatus, detail: string): Check {
  return { name, status, detail };
}

function editionCheck(f: MachineFacts): Check {
  const support = editionSupport(f.edition);
  const edition = (f.edition ?? 'unknown edition') + (f.build ? ', build ' + f.build : '');
  const name = 'Windows edition';
  if (support === 'supported' && (f.build ?? 18305) >= 18305) return check(name, 'ok', edition);
  if (support === 'home')
    return check(
      name,
      'action',
      edition + ': Windows Home cannot run Windows Sandbox. Upgrade to Pro (Settings > System > Activation).',
    );
  if (support === 'unsupported')
    return check(name, 'action', edition + ': Windows Sandbox needs Windows 10/11 Pro, Enterprise or Education.');
  if (support === 'supported')
    return check(name, 'action', edition + ': too old; Windows Sandbox needs Windows 10 version 1903 or newer.');
  return check(
    name,
    'warn',
    edition + ': not sure this edition has Windows Sandbox (it needs Pro, Enterprise or Education).',
  );
}

function virtualizationCheck(f: MachineFacts): Check {
  const name = 'CPU virtualization';
  const virt = f.hypervisorPresent || f.virtualizationFirmware;
  if (virt) return check(name, 'ok', f.hypervisorPresent ? 'on (hypervisor running)' : 'on');
  if (virt === false)
    return check(
      name,
      'action',
      "off. Turn on Intel VT-x / AMD-V (SVM) in your PC's BIOS/UEFI settings, then run this again.",
    );
  return check(
    name,
    'warn',
    'could not tell; if Windows Sandbox will not start, turn on VT-x / AMD-V in the BIOS/UEFI.',
  );
}

function featureCheck(f: MachineFacts): Check {
  const name = 'Windows Sandbox feature';
  if (f.feature === 'enabled' && f.sandboxExe) return check(name, 'ok', 'enabled');
  if (f.feature === 'pending' || f.feature === 'enabled')
    return check(name, 'action', 'enabled, but Windows needs a restart to finish.');
  if (f.sandboxExe) return check(name, 'ok', 'installed');
  return check(name, 'action', 'not enabled. In an admin PowerShell: ' + ENABLE_COMMAND + ', then restart.');
}

function memoryCheck(f: MachineFacts): Check {
  const gb = formatGb(f.totalRamBytes);
  if (f.totalRamBytes < 4 * GB) return check('Memory', 'action', gb + ': Windows Sandbox needs at least 4 GB.');
  if (f.totalRamBytes < 8 * GB) return check('Memory', 'warn', gb + ': works, but 8 GB or more is recommended.');
  return check('Memory', 'ok', gb);
}

function diskCheck(f: MachineFacts): Check {
  if (f.freeDiskBytes === null) return check('Free disk', 'warn', 'could not check the drive of ' + f.storageRoot);
  const free = formatGb(f.freeDiskBytes) + ' free for ' + f.storageRoot;
  if (f.freeDiskBytes < 5 * GB)
    return check('Free disk', 'action', free + ': free up space (toolchains need several GB).');
  if (f.freeDiskBytes < 20 * GB)
    return check('Free disk', 'warn', free + ': getting low; toolchains and caches can use several GB.');
  return check('Free disk', 'ok', free);
}

function nodeCheck(f: MachineFacts): Check {
  return nodeMajor(f.nodeVersion) >= 20
    ? check('Node.js', 'ok', f.nodeVersion)
    : check('Node.js', 'action', f.nodeVersion + ': needs 20 or newer (winget install OpenJS.NodeJS.LTS).');
}

export function buildChecks(f: MachineFacts): Check[] {
  return [editionCheck(f), virtualizationCheck(f), featureCheck(f), memoryCheck(f), diskCheck(f), nodeCheck(f)];
}
