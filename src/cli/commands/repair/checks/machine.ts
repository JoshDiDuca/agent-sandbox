// All-users install: can this user read the settings for the PC, is this user in the sharing group, is the data folder
// private, are the group's permissions gone when nothing is shared, and are there records of sandboxes that are gone.
// Only for an install in Program Files; every other install skips these.
import fs from 'node:fs';
import path from 'node:path';
import { errMsg, isInsideOrEqual, isLink } from '../../../../core/util/index.js';
import {
  SHARING_GROUP,
  groupEntries,
  parseIcacls,
  privacyProblems,
  sharedFolders,
  staleActiveRecords,
} from '../../../../host/health/index.js';
import {
  ActiveRecords,
  applyAcl,
  protectPrivateFolder,
  sharingAclPlan,
  currentUserName,
} from '../../../../host/sharing/index.js';
import { storageOf } from '../../../../host/storage/index.js';
import type { Check, Finding, FixOutcome, RepairEnv } from '../types.js';
import { ok, plural, sameUser } from './common.js';

const machine = (env: RepairEnv): boolean => env.layout?.scope === 'machine';
const usersDir = (env: RepairEnv): string => path.join(env.machineHome, 'users');
const records = (env: RepairEnv): ActiveRecords => new ActiveRecords(path.join(env.machineHome, 'active'));

/** The per-user folder under users\ that holds the storage root, or null when the root is somewhere else. */
function privateFolder(env: RepairEnv): string | null {
  const users = path.resolve(usersDir(env));
  const root = path.resolve(env.storageRoot);
  if (!isInsideOrEqual(users, root) || root.toLowerCase() === users.toLowerCase()) return null;
  return path.join(users, path.relative(users, root).split(path.sep)[0]);
}

/** Does this user have a shared sandbox running (their record says shared, and Windows says it runs)? */
function sharedRecord(env: RepairEnv): boolean {
  return (
    env.running &&
    records(env)
      .readAll()
      .some((r) => r.shared && r.dataPath.toLowerCase() === env.dataPath.toLowerCase())
  );
}

function icaclsOf(env: RepairEnv, dir: string) {
  const text = env.system.icacls(dir);
  return text === null ? null : parseIcacls(text, dir);
}

export const MACHINE_CHECKS: Check[] = [
  {
    id: 'machine-config',
    group: 'Install',
    name: 'Settings for this PC',
    applies: machine,
    run: (env: RepairEnv): Finding => {
      const file = path.join(env.machineHome, 'config.json');
      try {
        fs.accessSync(file, fs.constants.R_OK);
        return ok(file + ' is readable');
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return ok('no ' + file + ' (the built-in defaults apply)');
        return {
          status: 'needs-you',
          detail: file + ' cannot be read (' + errMsg(e) + ')',
          means: 'Without it your settings for this PC (and the shared defaults) are ignored or refused.',
          fix:
            'Sign out of Windows and in again if you were just added to the group "' +
            SHARING_GROUP +
            '"; otherwise ask an administrator to let that group read the file.',
        };
      }
    },
  },
  {
    id: 'machine-group',
    group: 'Install',
    name: 'Sharing group',
    applies: machine,
    timeoutMs: 30_000,
    run: (env: RepairEnv): Finding => {
      const members = env.system.groupMembers();
      if (members === null) return { status: 'skipped', detail: 'could not read the group "' + SHARING_GROUP + '"' };
      const user = currentUserName();
      if (!members.some((m) => sameUser(m, user)))
        return {
          status: 'needs-you',
          detail: user + ' is not in the group "' + SHARING_GROUP + '"',
          means: 'You cannot read the settings for this PC or use a sandbox someone shares.',
          fix:
            'Ask an administrator, or in an admin terminal run: net localgroup "' +
            SHARING_GROUP +
            '" ' +
            user +
            ' /add  (then sign out and in)',
        };
      const sid = env.record?.groupSid;
      if (sid && env.system.tokenHasGroup(sid) === false)
        return {
          status: 'needs-you',
          detail: user + ' is in the group, but this session was started before that',
          means: 'Windows only counts group membership after you sign in again.',
          fix: 'Sign out of Windows and in again.',
        };
      return ok(user + ' is in the group "' + SHARING_GROUP + '"');
    },
  },
  {
    id: 'machine-data-private',
    group: 'Data folder',
    name: 'Private data folder',
    applies: machine,
    timeoutMs: 30_000,
    run: (env: RepairEnv): Finding => {
      const dir = privateFolder(env);
      if (!dir) return ok(env.storageRoot + ' is not under ' + usersDir(env) + ' (your own choice; not shared)');
      if (!fs.existsSync(dir)) return ok(dir + ' is not created yet');
      if (isLink(dir))
        return {
          status: 'needs-you',
          detail: dir + ' is a link',
          means: 'It is refused: a link could lead elsewhere.',
          fix: 'Remove the link, or point storage.root at a real folder (sandbox storage move).',
        };
      const entries = icaclsOf(env, dir);
      if (!entries) return { status: 'skipped', detail: 'could not read the permissions of ' + dir };
      const bad = privacyProblems(entries, SHARING_GROUP);
      if (!bad.length) return ok(dir + ' is private to you');
      return {
        status: 'needs-you',
        detail: dir + ' can also be read by: ' + bad.join(', '),
        means: 'Your saved logins and history are in there; other users of this PC could read them.',
        plan: 'make ' + dir + ' private (you, SYSTEM and Administrators only)',
        data: dir,
      };
    },
    fix: (_env: RepairEnv, finding: Finding): FixOutcome => {
      const dir = String(finding.data);
      protectPrivateFolder(dir);
      return { done: 'made ' + dir + ' private' };
    },
  },
  {
    id: 'machine-stale-acl',
    group: 'Data folder',
    name: 'Sharing permissions',
    applies: (env: RepairEnv): boolean => machine(env) && Boolean(env.record?.groupSid),
    needsIdle: 'look',
    timeoutMs: 40_000,
    run: (env: RepairEnv): Finding => {
      const priv = privateFolder(env);
      if (!priv) return ok('your data folder is not in the shared tree; nothing is opened to the group');
      const folders = sharedFolders(storageOf(env.dataPath), env.dataPath).filter((d) => fs.existsSync(d));
      const stale: string[] = [];
      for (const dir of folders) {
        const entries = icaclsOf(env, dir);
        if (entries && groupEntries(entries, SHARING_GROUP).length) stale.push(dir);
      }
      if (!stale.length)
        return ok('the group "' + SHARING_GROUP + '" has no access to your folders (nothing is shared)');
      return {
        status: 'needs-you',
        detail: 'the group "' + SHARING_GROUP + '" still has access to ' + plural(stale.length, 'of your folder'),
        means: 'Others could enter your data folder although you are not sharing a sandbox.',
        plan:
          'remove the group from ' + plural(stale.length, 'folder') + ' (only those entries; nothing inside changes)',
        lines: stale,
      };
    },
    fix: (env: RepairEnv): FixOutcome => {
      const sid = env.record?.groupSid;
      if (!sid) throw new Error('install.json has no group');
      applyAcl(
        sharingAclPlan({ storageUserDir: storageOf(env.dataPath), dataPath: env.dataPath, groupSid: sid, on: false }),
      );
      return { done: 'removed the group from your folders' };
    },
  },
  {
    id: 'machine-run-shared',
    group: 'Data folder',
    name: 'Shared run folder',
    applies: (env: RepairEnv): boolean => machine(env) && Boolean(env.record?.groupSid),
    timeoutMs: 40_000,
    run: (env: RepairEnv): Finding => {
      if (!sharedRecord(env)) return ok('no sandbox of yours is shared right now');
      const run = path.join(env.dataPath, 'run');
      const entries = icaclsOf(env, run);
      if (!entries) return { status: 'skipped', detail: 'could not read the permissions of ' + run };
      if (groupEntries(entries, SHARING_GROUP).length) return ok('the group can use ' + run);
      return {
        status: 'warn',
        detail: 'your sandbox is shared but the group cannot use ' + run,
        means: 'Others cannot attach to it or run commands in it.',
        plan: 'open ' + run + ' to the group again',
      };
    },
    fix: (env: RepairEnv): FixOutcome => {
      const sid = env.record?.groupSid;
      if (!sid) throw new Error('install.json has no group');
      applyAcl(
        sharingAclPlan({ storageUserDir: storageOf(env.dataPath), dataPath: env.dataPath, groupSid: sid, on: true }),
      );
      return { done: 'opened the run folder to the group' };
    },
  },
  {
    id: 'machine-active-records',
    group: 'Sandbox',
    name: 'Sharing records',
    applies: machine,
    run: (env: RepairEnv): Finding => {
      const all = records(env).readAll();
      const stale = staleActiveRecords(all, env.system.processes());
      if (!stale.length) return ok(all.length ? plural(all.length, 'record') + ', all of a running sandbox' : 'none');
      return {
        status: 'needs-you',
        detail:
          plural(stale.length, 'record') +
          ' of sandboxes that are no longer running (' +
          stale.map((r) => r.user).join(', ') +
          ')',
        means: 'They can make other users think a sandbox is running or whose it is.',
        plan: 'remove ' + plural(stale.length, 'stale record'),
        data: stale.map((r) => r.sid),
      };
    },
    fix: (env: RepairEnv, finding: Finding): FixOutcome => {
      const sids = Array.isArray(finding.data) ? (finding.data as string[]) : [];
      // Looked at again now: a sandbox that started since is not removed.
      const still = staleActiveRecords(records(env).readAll(), env.system.processes()).filter((r) =>
        sids.includes(r.sid),
      );
      for (const r of still) records(env).clear(r.sid);
      return { done: 'removed ' + plural(still.length, 'stale record') };
    },
  },
];
