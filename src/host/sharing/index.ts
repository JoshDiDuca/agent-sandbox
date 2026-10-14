// Sharing a running sandbox between the Windows users of an all-users install: the machine folders, the records of
// who started what, who owns the running sandbox, and the folder permissions that let others use it.
export { machineRoot, activeDir } from './machine-paths.js';
export { ActiveRecords, ActiveSandboxSchema, type ActiveSandbox } from './active-record.js';
export { parseTasklist, whoOwnsSandbox, type SandboxOwner, type TaskRow } from './owner.js';
export { sharingAclPlan, applyAcl, runFolderAccess, type AclChange } from './acl.js';
