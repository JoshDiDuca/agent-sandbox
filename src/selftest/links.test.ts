// Links (junctions and symlinks) planted by a compromised sandbox in the folders this PC reads and writes: the host
// must never write, delete or walk through them.
import fs from 'node:fs';
import path from 'node:path';
import { activateAccount, saveAccount } from '../host/accounts.js';
import { resetRunDir, sendRequest } from '../host/channel.js';
import { pruneStorage } from '../host/cleanup.js';
import { assertNoLinks } from '../core/util/index.js';
import { syncHistoryIn } from '../sync/history.js';
import type { Suite } from './suite.js';

export const linksSuite: Suite = {
  name: 'links',
  title: 'links planted by the sandbox are never followed',
  run: async (t) => {
    const victim = t.at('victim');
    const precious = t.write(path.join(victim, 'precious.txt'), 'keep me');
    const storage = t.at('evil-storage');
    const data = t.dir('evil-storage', 'data', 'd');
    t.dir('evil-storage', 'data', 'd', 'state');

    t.section('writes under the data folder');
    fs.symlinkSync(victim, path.join(data, 'state', 'claude'), 'junction');
    await t.throws(
      () => assertNoLinks(data, path.join(data, 'state', 'claude', 'x.json')),
      'is a link',
      'any host write under the data folder through a junction is refused',
    );
    await t.throws(
      () => activateAccount(storage, data, 'any'),
      'Unknown account',
      'accounts never read through a sandbox junction',
    );
    await t.throws(
      () => saveAccount(storage, data, 'a', null),
      'is a link',
      'accounts never write through a sandbox junction',
    );

    t.section('history sync');
    const sides = {
      hostClaudeDir: t.at('link-host'),
      guestClaudeDir: t.at('link-guest'),
      hostWorkspace: 'D:\\Code\\my-app',
      guestWorkspace: 'C:\\Workspace\\my-app',
    };
    t.dir('link-guest', 'projects');
    fs.symlinkSync(victim, path.join(sides.guestClaudeDir, 'projects', 'C--Workspace-my-app'), 'junction');
    t.write(path.join(sides.hostClaudeDir, 'projects', 'D--Code-my-app', 's.jsonl'), '{}\n');
    syncHistoryIn(sides);
    t.check(
      !fs.existsSync(path.join(victim, 's.jsonl')),
      'history sync never writes through a junction inside the sandbox state',
    );
    fs.symlinkSync(precious, path.join(sides.guestClaudeDir, 'history.jsonl'), 'file');
    t.write(path.join(sides.hostClaudeDir, 'history.jsonl'), '{"display":"x","timestamp":1}\n');
    syncHistoryIn(sides);
    t.equal(
      fs.readFileSync(precious, 'utf8'),
      'keep me',
      'a file symlink planted in place of history.jsonl is replaced, not written through',
    );

    t.section('the run folder and cleanup');
    t.dir('evil-storage', 'data', 'd', 'run');
    fs.symlinkSync(victim, path.join(data, 'run', 'requests'), 'junction');
    await t.throws(
      () => sendRequest(data, { kind: 'ping', id: 'p1', createdAt: '' }),
      'is a link',
      'requests are never written through a junction',
    );
    t.check(!fs.existsSync(path.join(victim, 'p1.json')), "nothing was written into the junction's target");
    fs.symlinkSync(victim, path.join(data, 'run', 'sessions'), 'junction');
    resetRunDir(data);
    t.check(
      !fs.existsSync(path.join(data, 'run', 'sessions')),
      'resetting the run folder removes a junction itself...',
    );
    t.check(fs.existsSync(precious), '... never its target');
    fs.symlinkSync(victim, path.join(data, 'logs'), 'junction');
    const longAgo = new Date(Date.now() - 60 * 86400000);
    fs.utimesSync(precious, longAgo, longAgo);
    pruneStorage(storage);
    t.check(fs.existsSync(precious), 'cleanup never walks into a junction (old files on this PC stay)');
  },
};
