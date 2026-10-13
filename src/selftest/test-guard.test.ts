// The self-test's own safety net (shared/test-guard.ts, host/test-guard.ts): with AGENT_SANDBOX_SELFTEST=1, host code
// refuses every outward action and every write or delete outside the temp folder. If one of these ever stops
// refusing, a test could act on a real PC, so each is checked here. Nothing is created outside the temp folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAccount } from '../host/profile/index.js';
import { sendRequest } from '../host/channel/index.js';
import { hostClaude } from '../host/sandbox/index.js';
import { spawnDetached, startSandbox } from '../host/sandbox/index.js';
import { hideSandboxWindow, showSandboxWindow } from '../host/sandbox/index.js';
import { ensureTerminal, syncPwshProfile } from '../host/tools/index.js';
import { safeRemove } from '../shared/io/index.js';
import { writeJsonAtomic } from '../shared/io/index.js';
import { syncClaudeMem } from '../sync/index.js';
import { syncHistoryIn, syncHistoryOut } from '../sync/index.js';
import { watch } from '../sync/index.js';
import type { Suite } from './support/suite.js';

export const testGuardSuite: Suite = {
  name: 'test-guard',
  title: 'the self-test refuses to act on this PC',
  run: async (t) => {
    t.check(process.env.AGENT_SANDBOX_SELFTEST === '1', 'the self-test guard is switched on for the whole run');

    const real = path.join(os.homedir(), 'agent-sandbox-selftest-guard-probe');
    const sides = {
      hostClaudeDir: real,
      guestClaudeDir: t.at('guard-guest'),
      hostWorkspace: 'D:\\Code\\my-app',
      guestWorkspace: 'C:\\Workspace\\my-app',
    };
    const guardData = t.at('guard-data', 'data', 'd');
    const login = t.write(t.at('guard-login', '.credentials.json'), '{"claudeAiOauth":{}}');
    const blocked: [string, () => unknown][] = [
      ['start Windows Sandbox', () => startSandbox(t.at('storage', 'agent.wsb'))],
      [
        'start the background watcher process',
        () => spawnDetached(path.join(t.packageRoot, 'dist', 'bin', 'sandbox.js'), ['_watch']),
      ],
      ['run Claude Code on this PC', () => hostClaude(t.at('storage'), false, ['--version'])],
      ['hide windows', () => hideSandboxWindow(t.at('storage'), 1)],
      ['show windows', () => showSandboxWindow(t.at('storage'))],
      [
        'shut down Windows Sandbox',
        () =>
          sendRequest(guardData, {
            kind: 'exec',
            id: 'sd',
            command: ['C:\\Windows\\System32\\shutdown.exe', '/s'],
            cwd: 'C:\\',
            timeoutSeconds: 5,
            createdAt: '',
          }),
      ],
      ['start the background sync', () => watch(t.at('storage', 'data', 'w'))],
      ['write Windows Terminal settings', () => syncPwshProfile(real, true)],
      ['download Windows Terminal into a profile', () => ensureTerminal(real, true)],
      ['sync history into the real profile', () => syncHistoryOut(sides)],
      ['sync history into the sandbox state in a profile', () => syncHistoryIn({ ...sides, guestClaudeDir: real })],
      [
        'sync claude-mem into the real profile',
        () =>
          syncClaudeMem(
            real,
            t.at('mem-store'),
            { hostClaudeDir: real, hostWorkspace: 'D:\\x', guestWorkspace: 'C:\\x' },
            'out',
          ),
      ],
      ['write a state file in a profile', () => writeJsonAtomic(path.join(real, 'x.json'), {})],
      ['delete in a profile', () => safeRemove(path.join(real, 'x'), os.homedir())],
      [
        'save a login into a profile',
        () =>
          saveAccount(real, t.at('acct-storage', 'data', 'd'), 'work', {
            claudeDir: path.dirname(login),
            globalStateFile: t.at('guard-login', '.claude.json'),
          }),
      ],
    ];
    for (const [what, action] of blocked)
      await t.throws(async () => action(), /self-test/i, 'self-test mode refuses to ' + what);
    t.check(!fs.existsSync(real), 'nothing was created in the profile folder');

    writeJsonAtomic(t.at('guard-ok', 'x.json'), { fine: true });
    t.check(fs.existsSync(t.at('guard-ok', 'x.json')), 'the temp folder stays writable for the tests');
  },
};
