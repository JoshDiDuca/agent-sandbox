// `agent-sandbox self-test`: offline logic and security tests, plus live tests of the session daemon, ptyhost and
// the git guard when running on Windows (they need csc.exe and ConPTY, both part of Windows 10/11).
// They start real processes (the guest runtime, the daemon, csc, git), so they only run on a throwaway machine.
import os from 'node:os';
import { errMsg } from '../core/util.js';
import { configTests } from './config.test.js';
import { cliTests } from './cli.test.js';
import { dataTests } from './data.test.js';
import { detectTests } from './detect.test.js';
import { mirrorTests } from './mirror.test.js';
import { createFixtures } from './fixtures.js';
import { guestTests } from './guest.test.js';
import { createHarness } from './harness.js';
import { helperTests } from './helpers.test.js';
import { hostTests } from './host.test.js';
import { daemonTests, gitGuardTests, liveTestsAvailable } from './live.test.js';
import { securityTests } from './security.test.js';
import { setupTests } from './setup.test.js';
import { syncTests } from './sync.test.js';

/** Windows Sandbox (its user is always WDAGUtilityAccount) or a GitHub Actions runner: never someone's PC. */
export const onThrowawayMachine = (): boolean => os.userInfo().username.toLowerCase() === 'wdagutilityaccount' || process.env.GITHUB_ACTIONS === 'true';

export const selfTest = async (packageRoot: string): Promise<number> => {
  if (!onThrowawayMachine()) {
    console.error('The self-test only runs inside a Windows Sandbox, so it can never change this PC.\nRun it there: `sandbox start` in this folder, then `npm test` in the sandbox\'s terminal.');
    return 1;
  }
  // Defence in depth (shared/test-guard.ts): with this set, host code refuses outward actions and writes outside temp.
  process.env.AGENT_SANDBOX_SELFTEST = '1';
  const t = createHarness(packageRoot);
  const saved = { home: process.env.AGENT_SANDBOX_HOME, windir: process.env.WINDIR };
  process.env.AGENT_SANDBOX_HOME = t.temp + '\\user-home';
  try {
    const f = createFixtures(t);
    await configTests(t, f);
    const launchPath = await guestTests(t, f);
    await syncTests(t, f);
    await mirrorTests(t, f);
    await securityTests(t, f);
    helperTests(t);
    detectTests(t);
    setupTests(t);
    hostTests(t);
    dataTests(t);
    cliTests(t);
    if (liveTestsAvailable()) { await daemonTests(t, f, launchPath); await gitGuardTests(t, f, launchPath); }
    else console.log('SKIP  live tests (need Windows with the .NET Framework compiler)');
  } catch (e) {
    t.check(false, 'unexpected error: ' + errMsg(e) + (e instanceof Error && e.stack ? '\n' + e.stack : ''));
  } finally {
    if (saved.home === undefined) delete process.env.AGENT_SANDBOX_HOME; else process.env.AGENT_SANDBOX_HOME = saved.home;
    process.env.WINDIR = saved.windir;
    t.dispose();
  }
  const failures = t.failures();
  console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
  return failures === 0 ? 0 : 1;
};
