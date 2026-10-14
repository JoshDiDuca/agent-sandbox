// Claude accounts: saving logins from the sandbox or this PC, switching, and the names that are refused.
import fs from 'node:fs';
import path from 'node:path';
import { AccountStore } from '../host/profile/index.js';
import type { Suite } from './support/suite.js';

export const accountsSuite: Suite = {
  name: 'accounts',
  title: 'Claude accounts (save, switch, remove, safe names)',
  run: async (t, f) => {
    t.section('saving and switching');
    const storage = t.at('acct-storage');
    const dataA = path.join(storage, 'data', 'x');
    const sandboxClaude = path.join(dataA, 'state', 'claude');
    t.write(path.join(sandboxClaude, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"personal-1"}}');
    t.write(path.join(sandboxClaude, '.claude.json'), '{"oauthAccount":{"emailAddress":"me@personal"},"other":1}');
    new AccountStore(storage).save(dataA, 'personal', null);
    t.write(t.at('host-login', '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"work-1"}}');
    t.write(t.at('host-login.json'), '{"oauthAccount":{"emailAddress":"me@work"}}');
    new AccountStore(storage).save(dataA, 'work', {
      claudeDir: t.at('host-login'),
      globalStateFile: t.at('host-login.json'),
    });
    t.check(
      new AccountStore(storage).list(dataA).length === 2 &&
        new AccountStore(storage).defaultName() === 'personal' &&
        new AccountStore(storage).activeFor(dataA) === 'personal',
      'accounts can be saved from the sandbox and from this PC; the first one saved is the default and active',
    );
    t.check(
      !fs.existsSync(path.join(sandboxClaude, '.agent-sandbox-account')) &&
        fs.existsSync(path.join(storage, 'accounts', 'index.json')),
      'which account is active is recorded host-side, not inside the sandbox',
    );

    t.write(path.join(sandboxClaude, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"personal-2"}}');
    new AccountStore(storage).activate(dataA, 'work');
    const stateAfter = f.readJson(path.join(sandboxClaude, '.claude.json'));
    t.check(
      fs.readFileSync(path.join(sandboxClaude, '.credentials.json'), 'utf8').includes('work-1') &&
        stateAfter.oauthAccount.emailAddress === 'me@work' &&
        stateAfter.other === 1 &&
        new AccountStore(storage).activeFor(dataA) === 'work',
      'switching swaps in the other credentials and account, keeps the rest of the sandbox state, and marks it active',
    );
    t.includes(
      JSON.stringify(new AccountStore(storage).read('personal')?.credentials),
      'personal-2',
      "the outgoing account's refreshed tokens are saved back before switching",
    );

    t.section('removing and refusing');
    new AccountStore(storage).setDefault('work');
    new AccountStore(storage).remove('work');
    t.equal(new AccountStore(storage).defaultName(), null, 'removing the default account clears the default');
    await t.throws(
      () => new AccountStore(storage).activate(dataA, 'nope'),
      'Unknown account',
      'an unknown account cannot be activated',
    );
    await t.throws(
      () => new AccountStore(storage).save(dataA, '../x', null),
      'Invalid account name',
      'a path-like account name is rejected',
    );
    const victim = t.dir('victim');
    const otherData = t.at('acct-storage', 'data', 'd');
    const fromHost = { claudeDir: victim, globalStateFile: victim };
    await t.throws(
      () => new AccountStore(t.at('acct-storage')).save(otherData, 'index', fromHost),
      'Invalid account name',
      'an account cannot be called "index" (it would overwrite the index)',
    );
    await t.throws(
      () => new AccountStore(t.at('acct-storage')).save(otherData, 'con', fromHost),
      'Invalid account name',
      'an account cannot be named after a device (it would open a device)',
    );
  },
};
