import os from 'node:os';
import type { SandboxStatus } from '../../core/types.js';
import { now } from '../../shared/channel/run-dir.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { errMsg } from '../../core/util/errors.js';
import { warn } from './log.js';
import { run } from './paths.js';
import { session, workspace } from './session.js';

/** Best-effort: progress reporting must never be what breaks the boot. */
export const setSandboxStatus = (phase: SandboxStatus['phase'], message: string): void => {
  try {
    writeJsonAtomicChecked(phase, message);
  } catch (e) {
    warn('Could not update sandbox status: ' + errMsg(e));
  }
};

const ownAddresses = (): string[] =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => Boolean(i) && i!.family === 'IPv4' && !i!.internal)
    .map((i) => i.address)
    .slice(0, 8);

const writeJsonAtomicChecked = (phase: SandboxStatus['phase'], message: string): void => {
  writeJsonAtomic(run.sandbox, {
    launchId: session.launchId,
    phase,
    message,
    updatedAt: now(),
    workspaceHost: session.workspaceHost,
    guestWorkspace: workspace,
    headless: session.headless,
    addresses: ownAddresses(),
  } satisfies SandboxStatus);
};
