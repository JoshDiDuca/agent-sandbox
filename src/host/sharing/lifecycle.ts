// A sandbox's time as a shared one: at launch its owner writes the record that says whose it is and whether others may
// use it (and opens or closes the folders for them); when it ends the record goes and the folders close again. The
// pieces that touch the PC (the record folder, the permissions) are given, so tests run on temp folders.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import { InstallLayout, InstallRecordFile } from '../install/index.js';
import { storageOf } from '../storage/index.js';
import { sharingAclPlan, applyAcl, type AclChange } from './acl.js';
import { ActiveRecords, type ActiveSandbox } from './active-record.js';
import { activeDir } from './machine-paths.js';

export interface SharingDeps {
  readonly records: ActiveRecords;
  /** Applies folder permission changes (the real one refuses inside the self-test). */
  readonly apply: (changes: readonly AclChange[]) => void;
  /** The group of users who may share (from install.json); null: no permissions to change. */
  readonly groupSid: string | null;
}

/** What the launch knows about the sandbox it is about to start. */
export type SharingStart = Omit<ActiveSandbox, 'startedAt'> & { readonly startedAt?: string };

/**
 * The machinery of an all-users install, or null for every other install (nothing is shared there: one user, one
 * storage folder).
 */
export function sharingDeps(packageRoot: string): SharingDeps | null {
  const layout = InstallLayout.detect(packageRoot);
  if (layout?.scope !== 'machine') return null;
  return {
    records: new ActiveRecords(activeDir()),
    apply: applyAcl,
    groupSid: new InstallRecordFile(layout.root).read()?.groupSid ?? null,
  };
}

/** Writes the record, and opens (shared) or closes (not shared) the owner's folders for the group. */
export function beginSharing(deps: SharingDeps, start: SharingStart, now: Date = new Date()): void {
  deps.records.write({ ...start, startedAt: start.startedAt ?? now.toISOString() });
  if (!deps.groupSid) return;
  // The run folder exists once a sandbox has been generated; make sure, so the permissions have a folder to land on.
  fs.mkdirSync(path.join(start.dataPath, 'run'), { recursive: true });
  deps.apply(
    sharingAclPlan({
      storageUserDir: storageOf(start.dataPath),
      dataPath: start.dataPath,
      groupSid: deps.groupSid,
      on: start.shared,
    }),
  );
}

/** The sandbox of this data folder ended: its record goes and the group loses access again. Never throws. */
export function endSharing(deps: SharingDeps, dataPath: string): void {
  try {
    const mine = deps.records.readAll().filter((r) => r.dataPath.toLowerCase() === dataPath.toLowerCase());
    for (const record of mine) deps.records.clear(record.sid);
    if (deps.groupSid && fs.existsSync(path.join(dataPath, 'run')))
      deps.apply(
        sharingAclPlan({
          storageUserDir: storageOf(dataPath),
          dataPath,
          groupSid: deps.groupSid,
          on: false,
        }),
      );
  } catch {
    // Best effort: a stale record is ignored (its session has no sandbox), and the next launch sets the folders again.
  }
}

const SHARING_NOTICE =
  'Others in Agent Sandbox Users can attach to and run commands in this sandbox. Their sessions use the agent logins ' +
  'in it, and history goes to your account.';

const NoticeSchema = z.object({ told: z.literal(true) });

/** The sharing explanation the first time sharing is on for this user (null afterwards). */
export function takeSharingNotice(storageRoot: string): string | null {
  const file = new JsonFile(NoticeSchema, path.join(storageRoot, 'sharing-notice.json'));
  if (file.read()) return null;
  file.write({ told: true });
  return SHARING_NOTICE;
}
