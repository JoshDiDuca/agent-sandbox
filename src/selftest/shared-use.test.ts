// Sharing wired into the commands: what each user may do with the running sandbox (pure rules), the launch writing and
// clearing the record, the shared data folder taken from a record, and a borrowed project list. Temp folders only; the
// folder permissions go to a fake.
import path from 'node:path';
import { BorrowedRegistry } from '../host/projects/index.js';
import {
  ActiveRecords,
  beginSharing,
  endSharing,
  launchBlocked,
  ownerLine,
  ownerRule,
  sharedDataPath,
  takeSharingNotice,
  type ActiveSandbox,
  type AclChange,
  type SandboxOwner,
} from '../host/sharing/index.js';
import type { Harness } from './support/harness.js';
import type { Suite } from './support/suite.js';

const SID = 'S-1-5-21-1-2-3-1001';
const GROUP = 'S-1-5-21-1-2-3-5000';

const record = (dataPath: string, shared: boolean): ActiveSandbox => ({
  user: 'alice',
  sid: SID,
  windowsSession: 2,
  dataPath,
  shared,
  startedAt: '2026-10-14T09:00:00Z',
  version: '1.5.0',
  projects: [{ id: 'app', hostPath: 'C:\\Dev\\app', guestPath: 'C:\\Workspace\\app' }],
});
const other = (shared: boolean): SandboxOwner => ({
  kind: 'other',
  user: 'alice',
  shared,
  record: record('C:\\x', shared),
});

async function rules(t: Harness): Promise<void> {
  t.section('what a user may do with another user\u2019s sandbox');
  t.equal(ownerRule({ kind: 'mine' }, { kind: 'stop', sessions: 1 }).kind, 'allow', 'your own sandbox: everything');
  t.equal(ownerRule({ kind: 'none' }, { kind: 'use' }).kind, 'allow', 'nothing running: nothing to refuse');
  t.equal(ownerRule(other(false), { kind: 'look' }).kind, 'allow', 'status and sessions always work');
  t.equal(ownerRule(other(true), { kind: 'use' }).kind, 'allow', 'shared: attach, exec and db are allowed');
  const refused = ownerRule(other(false), { kind: 'use' });
  t.check(refused.kind === 'refuse' && refused.reason.includes('not shared'), 'not shared: attach is refused with why');
  const stop = ownerRule(other(true), { kind: 'stop', sessions: 2 });
  t.check(
    stop.kind === 'confirm' && stop.expected === 'alice' && stop.prompt.includes('2 sessions'),
    'shared: stop asks for the owner\u2019s name and names the session count',
  );
  t.equal(ownerRule(other(false), { kind: 'stop', sessions: 0 }).kind, 'refuse', 'not shared: stop is refused');
  const restart = ownerRule(other(true), { kind: 'owner-only', what: 'restart the agents' });
  t.check(
    restart.kind === 'refuse' && restart.reason === 'Only alice can restart the agents: the sandbox is theirs.',
    'restart, a new launch and the like are the owner\u2019s alone',
  );
  const window = ownerRule(other(true), { kind: 'owner-only', what: 'x', window: true });
  t.check(
    window.kind === 'refuse' && window.reason.includes("window is on alice's desktop"),
    'the window message says whose desktop it is on',
  );
  t.equal(ownerRule({ kind: 'unknown-other' }, { kind: 'use' }).kind, 'refuse', 'an unrecorded sandbox is not used');
  t.equal(ownerRule({ kind: 'unknown-other' }, { kind: 'look' }).kind, 'allow', 'but it can be looked at');
  const evil = { ...other(true), user: 'al\u001b[2Jice' };
  t.excludes(ownerLine(evil) ?? '', '\u001b', 'a name with terminal codes is cleaned before it is shown');
  t.equal(ownerLine(other(false)), 'Running, started by alice (not shared)', 'status line, not shared');
  t.equal(ownerLine(other(true)), 'Running, started by alice (shared with you)', 'status line, shared');
  t.equal(ownerLine({ kind: 'mine' }), null, 'your own sandbox needs no extra line');
  t.equal(
    launchBlocked(other(true)),
    'A Windows Sandbox started by alice is already running',
    'a launch is blocked by name',
  );
  t.equal(launchBlocked({ kind: 'mine' }), null, 'your own is handled by the usual message');
}

function lifecycle(t: Harness): void {
  t.section('launch writes the record and the permissions; the end clears them');
  const machine = t.dir('shared', 'machine');
  const records = new ActiveRecords(path.join(machine, 'active'));
  const storage = t.dir('shared', 'machine', 'users', 'alice');
  const dataPath = path.join(storage, 'data', 'default');
  const calls: AclChange[][] = [];
  const deps = { records, apply: (c: readonly AclChange[]) => void calls.push([...c]), groupSid: GROUP };
  const { startedAt: _ignored, ...start } = record(dataPath, true);
  void _ignored;
  beginSharing(deps, start, new Date('2026-10-14T09:00:00Z'));
  t.equal(records.readAll().length, 1, 'the record is written');
  t.equal(records.readAll()[0].shared, true, 'and says it is shared');
  t.check(calls[0].length === 4 && calls[0].every((c) => c.add), 'sharing on grants the group its four entries');
  endSharing(deps, dataPath);
  t.equal(records.readAll().length, 0, 'the end removes the record');
  t.check(calls[1].length === 4 && calls[1].every((c) => !c.add), 'and takes the entries away');
  beginSharing(deps, { ...start, shared: false });
  t.check(
    calls[2].every((c) => !c.add),
    'sharing off applies the removal, never a grant',
  );
  endSharing({ ...deps, groupSid: null }, dataPath);
  t.equal(records.readAll().length, 0, 'without a group there are no permissions to change, the record still goes');

  const notice = takeSharingNotice(storage);
  t.includes(
    notice ?? '',
    'Agent Sandbox Users can attach to and run commands',
    'the first sharing launch explains it',
  );
  t.equal(takeSharingNotice(storage), null, 'and only once');
}

async function borrowed(t: Harness): Promise<void> {
  t.section('using a shared sandbox: its folder and projects');
  const machine = t.dir('borrow', 'machine');
  const ok = path.join(machine, 'users', 'alice', 'data', 'default');
  t.equal(sharedDataPath(record(ok, true), machine), ok, 'a data folder under machine\\users\\<name>\\data is taken');
  for (const bad of [
    path.join(machine, 'users', 'alice', 'accounts'),
    path.join(machine, 'users', 'alice', 'data', 'default', 'run'),
    path.join(machine, 'users', 'alice', 'data'),
    path.join(machine, '..', 'elsewhere', 'data', 'default'),
    'C:\\Windows',
  ])
    await t.throws(() => sharedDataPath(record(bad, true), machine), 'points outside', 'refused: ' + bad);
  const registry = new BorrowedRegistry(record(ok, true)).read();
  t.equal(
    registry.projects.map((p) => p.host),
    ['C:\\Dev\\app'],
    'the projects come from the record',
  );
  t.equal(registry.projects[0].guest, 'C:\\Workspace\\app', 'with their paths in the sandbox');
  await t.throws(
    () => new BorrowedRegistry(record(ok, true)).save(),
    'theirs to change',
    'and cannot be changed from here',
  );
}

export const sharedUseSuite: Suite = {
  name: 'shared-use',
  title: 'sharing in the commands: rules, record at launch and end, borrowed folder and projects',
  run: async (t) => {
    await rules(t);
    lifecycle(t);
    await borrowed(t);
  },
};
