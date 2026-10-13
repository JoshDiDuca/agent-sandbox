// The .wsb file Windows Sandbox starts from: memory, devices and the folders mapped in.
import os from 'node:os';
import type { Config, ResolvedMapping } from '../../core/types.js';
import { fail, xmlEscape } from '../../core/util.js';
import { MIRROR_ROOT, sandboxFolder } from '../../shared/guest-paths.js';

export const GUEST = {
  launch: 'C:\\AgentLaunch',
  data: 'C:\\AgentData',
  hostTools: 'C:\\HostTools',
  mirror: MIRROR_ROOT,
} as const;
const toggle = (value: boolean): string => (value ? 'Enable' : 'Disable');

/** "auto": free RAM minus the reserve, but never more than maxMemoryMb or maxMemoryPercent of the PC's total RAM. */
export const resolveMemoryMb = (
  sandbox: Config['sandbox'],
  freeMemoryBytes = os.freemem(),
  totalMemoryBytes = os.totalmem(),
): number => {
  if (sandbox.memoryMb !== 'auto') return sandbox.memoryMb;
  const freeMb = Math.floor(freeMemoryBytes / 1048576);
  const shareMb = Math.floor(((totalMemoryBytes / 1048576) * sandbox.maxMemoryPercent) / 100);
  const rounded = Math.floor(Math.min(sandbox.maxMemoryMb, shareMb, freeMb - sandbox.reserveHostMb) / 1024) * 1024;
  if (rounded < 4096)
    fail(
      'Not enough free RAM for the sandbox (' +
        freeMb +
        ' MB free, ' +
        sandbox.reserveHostMb +
        ' MB kept for this PC).',
      'Close some apps, lower sandbox.reserveHostMb, or set sandbox.memoryMb to a fixed value (>= 4096).',
    );
  return rounded;
};

export const buildWsb = (config: Config, memoryMb: number, mappings: ResolvedMapping[]): string => {
  const s = config.sandbox;
  // Guest paths on other drive letters (F:\x) really live under C:\Mirror\F; bootstrap.ps1 substs F: onto it at boot.
  const folders = mappings
    .map(
      (m) =>
        '<MappedFolder><HostFolder>' +
        xmlEscape(m.host) +
        '</HostFolder><SandboxFolder>' +
        xmlEscape(sandboxFolder(m.guest)) +
        '</SandboxFolder><ReadOnly>' +
        String(m.readOnly) +
        '</ReadOnly></MappedFolder>',
    )
    .join('');
  return (
    '<Configuration>' +
    '<MemoryInMB>' +
    memoryMb +
    '</MemoryInMB>' +
    '<vGPU>' +
    toggle(s.vGpu) +
    '</vGPU>' +
    '<Networking>' +
    toggle(s.networking) +
    '</Networking>' +
    '<ClipboardRedirection>' +
    toggle(s.clipboard) +
    '</ClipboardRedirection>' +
    '<AudioInput>' +
    toggle(s.audioInput) +
    '</AudioInput>' +
    '<VideoInput>' +
    toggle(s.videoInput) +
    '</VideoInput>' +
    '<PrinterRedirection>' +
    toggle(s.printerRedirection) +
    '</PrinterRedirection>' +
    '<ProtectedClient>' +
    toggle(s.protectedClient) +
    '</ProtectedClient>' +
    '<MappedFolders>' +
    folders +
    '</MappedFolders>' +
    '<LogonCommand><Command>' +
    xmlEscape(GUEST.launch + '\\sandbox\\logon.cmd') +
    '</Command></LogonCommand>' +
    '</Configuration>'
  );
};
