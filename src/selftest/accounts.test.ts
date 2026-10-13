// Claude accounts: saving logins from the sandbox or this PC, switching, and the names that are refused.
import fs from 'node:fs';
import path from 'node:path';
import {
  activateAccount,
  activeAccount,
  defaultAccount,
  listAccounts,
  readAccount,
  removeAccount,
  saveAccount,
  setDefaultAccount,
} from '../host/profile/index.js';
import type { Suite } from './suite.js';

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
    saveAccount(storage, dataA, 'personal', null);
    t.write(t.at('host-login', '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"work-1"}}');
    t.write(t.at('host-login.json'), '{"oauthAccount":{"emailAddress":"me@work"}}');
    saveAccount(storage, dataA, 'work', { claudeDir: t.at('host-login'), globalStateFile: t.at('host-login.json') });
    t.equal(listAccounts(storage, dataA).length, 2, 'accounts can be saved from the sandbox and from this PC');
    t.equal(defaultAccount(storage), 'personal', 'the first account saved becomes the default');
    t.equal(activeAccount(dataA), 'personal', 'the first account saved is the active one');
    t.check(
      !fs.existsSync(path.join(sandboxClaude, '.agent-sandbox-account')),
      'which account is active is not recorded inside the sandbox...',
    );
    t.check(fs.existsSync(path.join(storage, 'accounts', 'index.json')), '... it is recorded host-side');

    t.write(path.join(sandboxClaude, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"personal-2"}}');
    activateAccount(storage, dataA, 'work');
    const stateAfter = f.readJson(path.join(sandboxClaude, '.claude.json'));
    t.includes(
      fs.readFileSync(path.join(sandboxClaude, '.credentials.json'), 'utf8'),
      'work-1',
      "switching swaps in the other account's credentials",
    );
    t.equal(stateAfter.oauthAccount.emailAddress, 'me@work', 'switching swaps the signed-in account');
    t.equal(stateAfter.other, 1, 'switching keeps the rest of the sandbox state');
    t.equal(activeAccount(dataA), 'work', 'the new account is active');
    t.includes(
      JSON.stringify(readAccount(storage, 'personal')?.credentials),
      'personal-2',
      "the outgoing account's refreshed tokens are saved back before switching",
    );

    t.section('removing and refusing');
    setDefaultAccount(storage, 'work');
    removeAccount(storage, 'work');
    t.equal(defaultAccount(storage), null, 'removing the default account clears the default');
    await t.throws(
      () => activateAccount(storage, dataA, 'nope'),
      'Unknown account',
      'an unknown account cannot be activated',
    );
    await t.throws(
      () => saveAccount(storage, dataA, '../x', null),
      'Invalid account name',
      'a path-like account name is rejected',
    );
    const victim = t.dir('victim');
    const otherData = t.at('acct-storage', 'data', 'd');
    const fromHost = { claudeDir: victim, globalStateFile: victim };
    await t.throws(
      () => saveAccount(t.at('acct-storage'), otherData, 'index', fromHost),
      'Invalid account name',
      'an account cannot be called "index" (it would overwrite the index)',
    );
    await t.throws(
      () => saveAccount(t.at('acct-storage'), otherData, 'con', fromHost),
      'Invalid account name',
      'an account cannot be named after a device (it would open a device)',
    );
  },
};
