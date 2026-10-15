// The guest's fixed folders, and how much memory the sandbox gets.
import os from 'node:os';
import type { Config } from '../../core/types.js';
import { fail } from '../../core/util/index.js';
import { MIRROR_ROOT } from '../../shared/paths/index.js';

export const GUEST = {
  launch: 'C:\\AgentLaunch',
  data: 'C:\\AgentData',
  hostTools: 'C:\\HostTools',
  mirror: MIRROR_ROOT,
} as const;

type SandboxSettings = Config['sandbox'];

const MB = 1048576;
const MIN_AUTO_MEMORY_MB = 4096;

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
