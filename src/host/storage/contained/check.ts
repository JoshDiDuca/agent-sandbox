// Can contained storage run on this PC? Windows, diskpart present, and not inside a Windows Sandbox (a sandbox has no
// Virtual Disk Service, and a nested one would only mount inside itself).
import fs from 'node:fs';
import { isWin } from '../../../core/util/index.js';
import { SYSTEM, system32 } from '../../../shared/system.js';
import { insideSandbox } from '../../sandbox/platform.js';
import type { ProviderCheck } from '../providers/types.js';

export interface ContainedFacts {
  readonly windows: boolean;
  readonly insideSandbox: boolean;
  readonly diskpartPresent: boolean;
  readonly powershellPresent: boolean;
}

export function containedFacts(): ContainedFacts {
  return {
    windows: isWin,
    insideSandbox: insideSandbox(),
    diskpartPresent: isWin && fs.existsSync(system32('diskpart.exe')),
    powershellPresent: isWin && fs.existsSync(SYSTEM.powershell()),
  };
}

export function containedAvailability(facts: ContainedFacts = containedFacts()): ProviderCheck {
  const reasons: string[] = [];
  const fixes: string[] = [];
  if (!facts.windows) {
    reasons.push('Contained storage needs Windows (it uses disk images).');
    fixes.push('Set storage.contained to "off".');
  } else {
    if (facts.insideSandbox) {
      reasons.push('This is inside a Windows Sandbox: disk images cannot be mounted here.');
      fixes.push('Run the command on your PC, not in a sandbox.');
    }
    if (!facts.diskpartPresent) {
      reasons.push('diskpart.exe was not found in Windows\\System32.');
      fixes.push('Repair Windows (sfc /scannow) or set storage.contained to "off".');
    }
    if (!facts.powershellPresent) {
      reasons.push('Windows PowerShell 5.1 was not found.');
      fixes.push('Repair Windows or set storage.contained to "off".');
    }
  }
  return { available: reasons.length === 0, reasons, fixes };
}
