// `git` wrapper used when provisioning.git.access is 'readonly' or 'none'. Installed first on PATH (git.cmd) and as a
// bash function (BASH_ENV), it decides per call and then runs the real git. Standalone on purpose: it runs on every
// git call, so it reads only two environment variables (AGENT_GIT_ACCESS, AGENT_REAL_GIT).
import { spawnSync } from 'node:child_process';
import { gitDecision } from '../git/decision.js';

if (process.argv[1]?.toLowerCase().endsWith('gitguard.js')) {
  const args = process.argv.slice(2);
  const decision = gitDecision(args, process.env.AGENT_GIT_ACCESS ?? 'none');
  if (!decision.allow) {
    console.error('fatal: ' + decision.reason);
    process.exit(128);
  }
  const real = process.env.AGENT_REAL_GIT;
  if (!real) {
    console.error('fatal: git is not available in this sandbox.');
    process.exit(128);
  }
  const result = spawnSync(real, args, { stdio: 'inherit', windowsHide: true });
  process.exit(result.status ?? 1);
}
