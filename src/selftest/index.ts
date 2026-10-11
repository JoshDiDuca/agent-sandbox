// `agent-sandbox self-test`: offline logic and security tests, plus live tests of the session daemon, ptyhost and
// the git guard when running on Windows (they need csc.exe and ConPTY, both part of Windows 10/11).
import { errMsg } from '../core/util.js';
import { configTests } from './config.test.js';
import { cliTests } from './cli.test.js';
import { dataTests } from './data.test.js';
import { detectTests } from './detect.test.js';
import { createFixtures } from './fixtures.js';
import { guestTests } from './guest.test.js';
import { createHarness } from './harness.js';
import { helperTests } from './helpers.test.js';
import { hostTests } from './host.test.js';
import { daemonTests, gitGuardTests, liveTestsAvailable } from './live.test.js';
import { securityTests } from './security.test.js';
import { setupTests } from './setup.test.js';
import { syncTests } from './sync.test.js';

export const selfTest = async (packageRoot: string): Promise<number> => {
  const t = createHarness(packageRoot);
  // The tests never see the real home folder, so nothing can write ~/.gitconfig, ~/.claude, ... by accident.
  const saved = { home: process.env.AGENT_SANDBOX_HOME, windir: process.env.WINDIR, userProfile: process.env.USERPROFILE, homeEnv: process.env.HOME };
  process.env.AGENT_SANDBOX_HOME = t.temp + '\\user-home';
  process.env.USERPROFILE = process.env.HOME = t.temp + '\\profile';
  try {
    const f = createFixtures(t);
    await configTests(t, f);
    const launchPath = await guestTests(t, f);
    await syncTests(t, f);
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
    const restore = (key: 'USERPROFILE' | 'HOME', value: string | undefined): void => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    restore('USERPROFILE', saved.userProfile);
    restore('HOME', saved.homeEnv);
    t.dispose();
  }
  const failures = t.failures();
  console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
  return failures === 0 ? 0 : 1;
};
