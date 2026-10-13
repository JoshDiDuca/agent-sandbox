// The .wsb file Windows Sandbox starts from: memory, devices and the folders mapped in.
import os from 'node:os';
import type { Config, ResolvedMapping } from '../../core/types.js';
import { fail, xmlEscape } from '../../core/util/index.js';
import { MIRROR_ROOT, sandboxFolder } from '../../shared/paths/index.js';

export const GUEST = {
  launch: 'C:\\AgentLaunch',
  data: 'C:\\AgentData',
  hostTools: 'C:\\HostTools',
  mirror: MIRROR_ROOT,
} as const;

type SandboxSettings = Config['sandbox'];
/** The on/off sandbox settings. */
type DeviceSetting = {
  [K in keyof SandboxSettings]: SandboxSettings[K] extends boolean ? K : never;
}[keyof SandboxSettings];

/** The .wsb elements switched on or off by a sandbox setting, in the order Windows Sandbox expects them. */
const DEVICES = [
  ['vGPU', 'vGpu'],
  ['Networking', 'networking'],
  ['ClipboardRedirection', 'clipboard'],
  ['AudioInput', 'audioInput'],
  ['VideoInput', 'videoInput'],
  ['PrinterRedirection', 'printerRedirection'],
  ['ProtectedClient', 'protectedClient'],
] as const satisfies readonly (readonly [string, DeviceSetting])[];

const MB = 1048576;
const MIN_AUTO_MEMORY_MB = 4096;

function element(name: string, value: string): string {
  return '<' + name + '>' + value + '</' + name + '>';
}
function toggle(value: boolean): string {
  return value ? 'Enable' : 'Disable';
}

/** "auto": free RAM minus the reserve, but never more than maxMemoryMb or maxMemoryPercent of the PC's total RAM. */
export function resolveMemoryMb(
  sandbox: SandboxSettings,
  freeMemoryBytes = os.freemem(),
  totalMemoryBytes = os.totalmem(),
): number {
  if (sandbox.memoryMb !== 'auto') return sandbox.memoryMb;
  const freeMb = Math.floor(freeMemoryBytes / MB);
  const shareMb = Math.floor(((totalMemoryBytes / MB) * sandbox.maxMemoryPercent) / 100);
  const rounded = Math.floor(Math.min(sandbox.maxMemoryMb, shareMb, freeMb - sandbox.reserveHostMb) / 1024) * 1024;
  if (rounded < MIN_AUTO_MEMORY_MB)
    fail(
      'Not enough free RAM for the sandbox (' +
        freeMb +
        ' MB free, ' +
        sandbox.reserveHostMb +
        ' MB kept for this PC).',
      'Close some apps, lower sandbox.reserveHostMb, or set sandbox.memoryMb to a fixed value (>= 4096).',
    );
  return rounded;
}

export function buildWsb(config: Config, memoryMb: number, mappings: ResolvedMapping[]): string {
  const s = config.sandbox;
  // Guest paths on other drive letters (F:\x) really live under C:\Mirror\F; bootstrap.ps1 substs F: onto it at boot.
  const folders = mappings
    .map((m) =>
      element(
        'MappedFolder',
        element('HostFolder', xmlEscape(m.host)) +
          element('SandboxFolder', xmlEscape(sandboxFolder(m.guest))) +
          element('ReadOnly', String(m.readOnly)),
      ),
    )
    .join('');
  return element(
    'Configuration',
    element('MemoryInMB', String(memoryMb)) +
      DEVICES.map(([name, setting]) => element(name, toggle(s[setting]))).join('') +
      element('MappedFolders', folders) +
      element('LogonCommand', element('Command', xmlEscape(GUEST.launch + '\\sandbox\\logon.cmd'))),
  );
}
