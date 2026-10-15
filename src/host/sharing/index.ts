// Sharing a running sandbox between the Windows users of an all-users install: the machine folders, the records of
// who started what, who owns the running sandbox, and the folder permissions that let others use it.
export { machineRoot, activeDir } from './machine-paths.js';
export { ActiveRecords, ActiveSandboxSchema, type ActiveSandbox } from './active-record.js';
export { parseTasklist, whoOwnsSandbox, type SandboxOwner, type TaskRow } from './owner.js';
export { currentUserName, currentUserSid, listProcesses, runningOwner, sessionOf } from './current.js';
export { ownerLine, ownerName, ownerRule, launchBlocked, type OwnerAction, type OwnerRule } from './rules.js';
export { sharedDataPath, type Borrowed } from './borrow.js';
export {
  beginSharing,
  endSharing,
  sharingDeps,
  takeSharingNotice,
  type SharingDeps,
  type SharingStart,
} from './lifecycle.js';
export {
  sharingAclPlan,
  applyAcl,
  protectPrivateFolder,
  runFolderAccess,
  runPrivateFolder,
  type AclChange,
} from './acl.js';
export { machineDoctorRows } from './doctor.js';
