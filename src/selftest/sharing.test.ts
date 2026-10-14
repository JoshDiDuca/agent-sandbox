// Machine-wide settings (the machine file under the user file), the records of who started a sandbox, who owns the
// running one, and the folder permissions for sharing. Everything happens in temp folders; the folder-permission
// script runs on the temp folders only, and only on Windows.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULTS, loadConfig, machineConfigPath } from '../core/config/index.js';
import { ConfigSchema, LocalOverridesSchema } from '../core/schema/index.js';
import { nativeFile, nativeScript } from '../host/native.js';
import {
  ActiveRecords,
  parseTasklist,
  runFolderAccess,
  sharingAclPlan,
  whoOwnsSandbox,
  type ActiveSandbox,
} from '../host/sharing/index.js';
import { SYSTEM } from '../shared/system.js';
import type { Suite } from './support/suite.js';
import type { Harness } from './support/harness.js';

const ALICE_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const BOB_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const GROUP_SID = 'S-1-5-21-1111111111-2222222222-3333333333-5000';

/** A record as a starter writes it. */
function record(sid: string, extra: Partial<ActiveSandbox> = {}): ActiveSandbox {
  return {
    user: sid === ALICE_SID ? 'alice' : 'bob',
    sid,
    windowsSession: 2,
    dataPath: 'C:\\Users\\alice\\AgentSandbox\\data\\default',
    shared: true,
    startedAt: '2026-10-14T09:00:00Z',
    version: '1.4.3',
    projects: [{ id: 'app', hostPath: 'C:\\Dev\\app', guestPath: 'C:\\Workspace\\app' }],
    ...extra,
  };
}

// Five process rows (the sandbox window in session 2) and the INFO line tasklist prints when a filter matches nothing.
const TASKLIST = [
  '"explorer.exe","4120","Console","1","123,456 K"',
  '"WindowsSandboxClient.exe","8124","Console","2","1,234 K"',
  '"svchost.exe","900","Services","0","12,345 K"',
  '"conhost.exe","8130","Console","2","4,096 K"',
  '',
  'INFO: No tasks are running which match the specified criteria.',
  '',
].join('\r\n');

/** Layers: defaults, the machine file, the user file. */
async function layering(t: Harness): Promise<void> {
  t.section('layering: machine file under the user file');
  t.equal(
    machineConfigPath({ ProgramData: 'D:\\PD' }),
    path.join('D:\\PD', 'AgentSandbox', 'config.json'),
    'the machine file is %ProgramData%\\AgentSandbox\\config.json',
  );
  t.equal(
    machineConfigPath({ AGENT_SANDBOX_MACHINE_HOME: t.at('m') }),
    path.join(t.at('m'), 'config.json'),
    'AGENT_SANDBOX_MACHINE_HOME moves the machine folder (tests)',
  );

  const quiet = loadConfig();
  t.equal(
    { machine: quiet.layers?.machine, user: quiet.layers?.user, otherUsers: quiet.config.sharing.otherUsers },
    { machine: null, user: null, otherUsers: false },
    'no machine file and no user file: today’s behaviour (defaults, sharing off)',
  );

  const machineFile = t.writeJson(machineConfigPath(), {
    sharing: { otherUsers: true },
    storage: { root: t.at('machine-storage') },
  });
  const machineOnly = loadConfig();
  t.equal(
    {
      otherUsers: machineOnly.config.sharing.otherUsers,
      root: machineOnly.config.storage.root,
      machine: machineOnly.layers?.machine,
      configPath: machineOnly.configPath,
    },
    { otherUsers: true, root: t.at('machine-storage'), machine: machineFile, configPath: null },
    'a machine file alone applies (sharing on, its storage root), with no user file',
  );

  const userFile = t.writeJson(t.at('user', 'config.json'), { sharing: { otherUsers: false } });
  const both = loadConfig(userFile);
  t.equal(
    {
      otherUsers: both.config.sharing.otherUsers,
      root: both.config.storage.root,
      layers: both.layers,
    },
    { otherUsers: false, root: t.at('machine-storage'), layers: { machine: machineFile, user: userFile } },
    'the user file wins over the machine file; keys it does not set keep the machine value; both paths reported',
  );

  const overridden = t.writeJson(t.at('user2', 'config.json'), { storage: { root: t.at('mine') } });
  t.equal(
    loadConfig(overridden).config.storage.root,
    t.at('mine'),
    'a storage root in the user file wins over the machine file',
  );

  t.writeJson(machineFile, { storage: { root: 'relative\\store' } });
  await t.throws(() => loadConfig(), 'must be a full path', 'a relative folder in the machine file is refused');
  await t.throws(() => loadConfig(), 'storage.root', 'the refusal names the key');

  t.writeJson(machineFile, { mappings: [{ host: 'rel-folder', guest: 'C:\\Rel', readOnly: true }] });
  await t.throws(() => loadConfig(), 'mappings[0].host', 'a relative mapping in the machine file is refused');

  t.writeJson(machineFile, { sharing: { otherUsers: 'yes' } });
  await t.throws(() => loadConfig(), 'otherUsers', 'a machine file is validated like a user file');
}

/** A project file can never make this PC's sandbox shared; the user file can. */
function projectCannotShare(t: Harness): void {
  t.section('sharing is a user (or machine) setting only');
  t.check(
    !LocalOverridesSchema.safeParse({ sharing: { otherUsers: true } }).success,
    'a project file (LocalOverrides) cannot set sharing.otherUsers',
  );
  t.check(
    ConfigSchema.safeParse({ ...DEFAULTS, sharing: { otherUsers: true } }).success,
    'the full config schema accepts sharing.otherUsers',
  );
}

/** Records: write, read, clear, and what is skipped (corrupt, mismatched, a folder, a link). */
function recordsSection(t: Harness): void {
  t.section('active records');
  const dir = t.dir('active');
  const records = new ActiveRecords(dir);
  t.equal(records.readAll(), [], 'a missing folder reads as no records');

  records.write(record(ALICE_SID));
  t.equal(
    records.readAll().map((r) => r.user),
    ['alice'],
    'a written record is read back',
  );
  records.write(record(BOB_SID, { shared: false, windowsSession: 3 }));
  t.equal(records.readAll().length, 2, 'each user has their own record');
  records.clear(BOB_SID);
  t.equal(
    records.readAll().map((r) => r.sid),
    [ALICE_SID],
    'clear removes only that user’s record',
  );

  const corruptSid = 'S-1-5-21-1111111111-2222222222-3333333333-1003';
  t.write(path.join(dir, corruptSid + '.json'), '{ not json');
  const wrongName = 'S-1-5-21-1111111111-2222222222-3333333333-1004';
  t.writeJson(path.join(dir, wrongName + '.json'), record('S-1-5-21-1111111111-2222222222-3333333333-1005'));
  fs.mkdirSync(path.join(dir, 'S-1-5-21-1111111111-2222222222-3333333333-1006.json'));
  t.equal(
    records.readAll().map((r) => r.sid),
    [ALICE_SID],
    'a corrupt file, a file named for another SID, and a folder are skipped',
  );

  const linked = 'S-1-5-21-1111111111-2222222222-3333333333-1007';
  const outside = t.writeJson(t.at('outside', 'record.json'), record(linked));
  try {
    fs.symlinkSync(outside, path.join(dir, linked + '.json'), 'file');
    t.equal(
      records.readAll().map((r) => r.sid),
      [ALICE_SID],
      'a link to a valid record is skipped (never followed)',
    );
  } catch {
    t.skip('file links need a privilege this user may lack; the link check did not run');
  }

  const badSid = { ...record(ALICE_SID), sid: '..\\evil' };
  let refused = false;
  try {
    records.write(badSid as ActiveSandbox);
  } catch {
    refused = true;
  }
  t.check(refused, 'a record with a bad SID is refused on write (its file name would leave the folder)');
}

/** Who owns the running sandbox, from a recorded tasklist sample. */
function ownership(t: Harness): void {
  t.section('tasklist and the sandbox owner');
  const rows = parseTasklist(TASKLIST);
  t.equal(rows.length, 4, 'four process rows; the INFO line and blank lines are skipped');
  t.equal(
    rows[1],
    { image: 'WindowsSandboxClient.exe', pid: 8124, session: 2 },
    'a quoted Mem with a thousands separator does not break a row',
  );

  const none = parseTasklist('"explorer.exe","4120","Console","1","123,456 K"');
  t.equal(whoOwnsSandbox(none, 1, []).kind, 'none', 'no sandbox running: none');
  t.equal(whoOwnsSandbox(rows, 2, []).kind, 'mine', 'the sandbox is in my session: mine');
  const aliceShared = whoOwnsSandbox(rows, 1, [record(ALICE_SID, { windowsSession: 2, shared: true })]);
  t.equal(
    aliceShared.kind === 'other' ? { user: aliceShared.user, shared: aliceShared.shared } : aliceShared.kind,
    { user: 'alice', shared: true },
    'another user’s sandbox that they shared: other, shared',
  );
  const bobPrivate = whoOwnsSandbox(rows, 1, [record(BOB_SID, { windowsSession: 2, shared: false })]);
  t.equal(
    bobPrivate.kind === 'other' ? { user: bobPrivate.user, shared: bobPrivate.shared } : bobPrivate.kind,
    { user: 'bob', shared: false },
    'another user’s sandbox that they did not share: other, not shared',
  );
  t.equal(whoOwnsSandbox(rows, 1, []).kind, 'unknown-other', 'a sandbox with no record: unknown-other');
  t.equal(
    whoOwnsSandbox(rows, 1, [record(ALICE_SID, { windowsSession: 9 })]).kind,
    'unknown-other',
    'a record whose session has no running sandbox is stale and ignored',
  );
  const remoteOnly = parseTasklist('"WindowsSandboxRemoteSession.exe","777","Console","3","900 K"');
  t.equal(
    whoOwnsSandbox(remoteOnly, 1, [record(ALICE_SID, { windowsSession: 3 })]).kind,
    'other',
    'WindowsSandboxRemoteSession.exe is recognised when the client is absent',
  );
}

/** The permission entries sharing needs, on and off. */
async function permissionPlan(t: Harness): Promise<void> {
  t.section('folder permissions for sharing');
  const storageUserDir = t.at('ProgramData', 'AgentSandbox', 'users', 'alice');
  const dataPath = path.join(storageUserDir, 'data', 'default');
  const entries = (add: boolean) => [
    { path: storageUserDir, sid: GROUP_SID, rights: 'Traverse', scope: 'this-folder', add },
    { path: path.join(storageUserDir, 'data'), sid: GROUP_SID, rights: 'Traverse', scope: 'this-folder', add },
    { path: dataPath, sid: GROUP_SID, rights: 'Traverse', scope: 'this-folder', add },
    { path: path.join(dataPath, 'run'), sid: GROUP_SID, rights: 'Modify', scope: 'inherit', add },
  ];
  t.equal(
    sharingAclPlan({ storageUserDir, dataPath, groupSid: GROUP_SID, on: true }),
    entries(true),
    'sharing on: traverse on the user folder, data folder and data set; modify (inherited) on run',
  );
  t.equal(
    sharingAclPlan({ storageUserDir, dataPath, groupSid: GROUP_SID, on: false }),
    entries(false),
    'sharing off: the same entries are removed',
  );
  await t.throws(
    () => sharingAclPlan({ storageUserDir, dataPath: t.at('elsewhere', 'default'), groupSid: GROUP_SID, on: true }),
    'not under',
    'a data set outside the user folder is refused',
  );
}

/** The PowerShell scripts: they parse, change a temp folder's permissions, and refuse links. Windows only. */
function folderScript(t: Harness): void {
  t.section('set-folder-access.ps1');
  if (process.platform !== 'win32') {
    t.skip('the folder-permission script runs only on Windows');
    return;
  }
  for (const script of ['set-folder-access.ps1', 'check-syntax.ps1']) {
    const parsed = spawnSync(
      SYSTEM.powershell(),
      nativeScript('check-syntax.ps1', ['-Path', nativeFile('scripts', script)]),
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    t.equal(parsed.status, 0, script + ' parses with Windows PowerShell 5.1 (' + (parsed.stderr || '').trim() + ')');
  }

  const who = spawnSync(SYSTEM.whoami(), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const match = /"([^"]+)","(S-1-[0-9-]+)"/.exec(who.stdout ?? '');
  if (!match) {
    t.skip('could not read the current user SID with whoami');
    return;
  }
  const [, account, sid] = match;
  const target = t.dir('acl-target');
  const icacls = (): string =>
    (spawnSync(SYSTEM.icacls(), [target], { encoding: 'utf8', windowsHide: true }).stdout ?? '').toLowerCase();
  const explicitRead = account.toLowerCase() + ':(r)';

  runFolderAccess([{ path: target, sid, rights: 'Read', scope: 'this-folder', add: true }]);
  t.includes(icacls(), explicitRead, 'adding a Read entry grants it on the temp folder');
  runFolderAccess([{ path: target, sid, rights: 'Read', scope: 'this-folder', add: false }]);
  t.excludes(icacls(), explicitRead, 'removing the same entry takes it away again');

  const link = t.at('acl-link');
  fs.symlinkSync(target, link, 'junction');
  let refused = '';
  try {
    runFolderAccess([{ path: link, sid, rights: 'Read', scope: 'this-folder', add: true }]);
  } catch (e) {
    refused = (e as Error).message;
  }
  t.includes(refused, 'link', 'a junction is refused, and nothing is changed through it');
}

export const sharingSuite: Suite = {
  name: 'sharing',
  title: 'machine settings, sharing records, sandbox owner, folder permissions',
  run: async (t) => {
    const savedMachine = process.env.AGENT_SANDBOX_MACHINE_HOME;
    process.env.AGENT_SANDBOX_MACHINE_HOME = t.at('machine-home');
    try {
      await layering(t);
      projectCannotShare(t);
      recordsSection(t);
      ownership(t);
      await permissionPlan(t);
      folderScript(t);
    } finally {
      // Later suites load the settings too: the machine file this suite wrote must not outlive it.
      fs.rmSync(t.at('machine-home'), { recursive: true, force: true });
      if (savedMachine === undefined) delete process.env.AGENT_SANDBOX_MACHINE_HOME;
      else process.env.AGENT_SANDBOX_MACHINE_HOME = savedMachine;
    }
  },
};
