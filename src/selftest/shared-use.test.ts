// Sharing wired into the commands: what each user may do with the running sandbox (pure rules), the launch writing and
// clearing the record, the shared data folder taken from a record, and a borrowed project list. Temp folders only; the
// folder permissions go to a fake.
import fs from 'node:fs';
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
const other = (shared: boolean, user = 'alice'): SandboxOwner => ({
  kind: 'other',
  user,
  shared,
  record: record('C:\\x', shared),
});

function rules(t: Harness): void {
  t.section('what a user may do with another user\u2019s sandbox');
  t.equal(
    [
      ownerRule({ kind: 'mine' }, { kind: 'stop', sessions: 1 }).kind,
      ownerRule({ kind: 'none' }, { kind: 'use' }).kind,
      ownerRule(other(false), { kind: 'look' }).kind,
      ownerRule(other(true), { kind: 'use' }).kind,
      ownerRule({ kind: 'unknown-other' }, { kind: 'look' }).kind,
    ],
    ['allow', 'allow', 'allow', 'allow', 'allow'],
    'allowed: your own sandbox, nothing running, looking at any, using a shared one',
  );
  const refused = ownerRule(other(false), { kind: 'use' });
  const stop = ownerRule(other(true), { kind: 'stop', sessions: 2 });
  t.check(
    refused.kind === 'refuse' &&
      refused.reason.includes('not shared') &&
      ownerRule(other(false), { kind: 'stop', sessions: 0 }).kind === 'refuse' &&
      ownerRule({ kind: 'unknown-other' }, { kind: 'use' }).kind === 'refuse' &&
      stop.kind === 'confirm' &&
      stop.expected === 'alice' &&
      stop.prompt.includes('2 sessions'),
    'not shared or unrecorded: use and stop are refused; shared: stop asks for the owner’s name and the session count',
  );
  const restart = ownerRule(other(true), { kind: 'owner-only', what: 'restart the agents' });
  const window = ownerRule(other(true), { kind: 'owner-only', what: 'x', window: true });
  t.check(
    restart.kind === 'refuse' &&
      restart.reason === 'Only alice can restart the agents: the sandbox is theirs.' &&
      window.kind === 'refuse' &&
      window.reason.includes("window is on alice's desktop"),
    'restart, a new launch and the like are the owner’s alone, and the window message says whose desktop it is on',
  );
  t.check(
    !(ownerLine(other(true, 'al\u001b[2Jice')) ?? '').includes('\u001b') &&
      ownerLine(other(false)) === 'Running, started by alice (not shared)' &&
      ownerLine(other(true)) === 'Running, started by alice (shared with you)' &&
      ownerLine({ kind: 'mine' }) === null &&
      launchBlocked(other(true)) === 'A Windows Sandbox started by alice is already running' &&
      launchBlocked({ kind: 'mine' }) === null,
    'the owner is named in the status line and a blocked launch; terminal codes in a name are cleaned',
  );
}

function lifecycle(t: Harness): void {
  t.section('launch writes the record and the permissions; the end clears them');
  const machine = t.dir('shared', 'machine');
  const records = new ActiveRecords(path.join(machine, 'active'));
  const storage = t.dir('shared', 'machine', 'users', 'alice');
  const dataPath = path.join(storage, 'data', 'default');
  const calls: AclChange[][] = [];
  const deps = {
    records,
    apply: (c: readonly AclChange[]) => void calls.push([...c]),
    groupSid: GROUP,
    usersDir: path.join(machine, 'users'),
  };
  const { startedAt: _ignored, ...start } = record(dataPath, true);
  void _ignored;
  beginSharing(deps, start, new Date('2026-10-14T09:00:00Z'));
  t.check(
    records.readAll().length === 1 &&
      records.readAll()[0].shared &&
      calls[0].length === 4 &&
      calls[0].every((c) => c.add),
    'the record is written as shared and the group is granted its four entries',
  );
  t.check(
    ['requests', 'responses', 'sessions'].every((d) => fs.existsSync(path.join(dataPath, 'run', d))),
    'the owner creates the channel folders before others may write there',
  );
  endSharing(deps, dataPath);
  t.check(
    records.readAll().length === 0 && calls[1].length === 4 && calls[1].every((c) => !c.add),
    'the end removes the record and takes the entries away',
  );
  beginSharing(deps, { ...start, shared: false });
  endSharing({ ...deps, groupSid: null }, dataPath);
  t.check(
    calls[2].every((c) => !c.add) && records.readAll().length === 0,
    'sharing off applies the removal, never a grant; without a group only the record goes',
  );
  const own = path.join(t.dir('shared', 'profile', 'AgentSandbox'), 'data', 'default');
  beginSharing(deps, { ...start, dataPath: own });
  endSharing(deps, own);
  t.check(
    calls.length === 3 && !fs.existsSync(path.join(own, 'run')),
    'a data folder outside machine\\users is never opened to the group, even with sharing on',
  );

  const notice = takeSharingNotice(storage);
  t.check(
    (notice ?? '').includes('Agent Sandbox Users can attach to and run commands') &&
      takeSharingNotice(storage) === null,
    'the first sharing launch explains it, once',
  );
}

async function borrowed(t: Harness): Promise<void> {
  t.section('using a shared sandbox: its folder and projects');
  const machine = t.dir('borrow', 'machine');
  const ok = path.join(machine, 'users', 'alice', 'data', 'default');
  t.equal(sharedDataPath(record(ok, true), machine), ok, 'a data folder under machine\\users\\<name>\\data is taken');
  for (const bad of [
    path.join(machine, 'users', 'alice', 'accounts'),
    path.join(machine, 'users', 'alice', 'data', 'default', 'run'),
    path.join(machine, '..', 'elsewhere', 'data', 'default'),
    'C:\\Windows',
  ])
    await t.throws(() => sharedDataPath(record(bad, true), machine), 'points outside', 'refused: ' + bad);
  const registry = new BorrowedRegistry(record(ok, true)).read();
  t.check(
    registry.projects.map((p) => p.host).join() === 'C:\\Dev\\app' &&
      registry.projects[0].guest === 'C:\\Workspace\\app',
    'the projects come from the record, with their paths in the sandbox',
  );
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
    rules(t);
    lifecycle(t);
    await borrowed(t);
  },
};
