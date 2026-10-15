// The real wiring of contained storage on this PC: the permission-prompt scripts, protectPrivateFolder for new
// folders, your SID, and whether a sandbox runs. Lives here (not in host/storage) so storage never imports the
// sandbox or sharing folders, which import storage. The self-test never reaches a disk through it: the disk port
// refuses there.
import { ScriptDiskPort, type ContainedDeps } from '../storage/index.js';
import { currentUserSid, protectPrivateFolder } from '../sharing/index.js';
import { isSandboxRunning } from './platform.js';

export function realContainedDeps(storageRoot: string, maxGb: number): ContainedDeps {
  return {
    storageRoot,
    maxGb,
    protect: (dir) => protectPrivateFolder(dir),
    userSid: currentUserSid,
    port: new ScriptDiskPort(),
    sandboxRunning: isSandboxRunning,
  };
}
