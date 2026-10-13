// Live: compiles gitshim.cs with the .NET Framework compiler and runs real git through it in a scratch repository,
// as git.exe and through Git Bash, in each git access mode.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findOnPath } from '../core/util/index.js';
import { CSC } from './support/live.js';
import type { Suite } from './support/suite.js';

export const liveGitSuite: Suite = {
  name: 'live-git',
  title: 'live: the git access guard (compiled git.exe stand-in, Git Bash)',
  live: true,
  run: async (t, f) => {
    const realGit = findOnPath(['git.exe']);
    if (!realGit) {
      t.skip('git guard (no git.exe on PATH)');
      return;
    }
    const gen = await f.launch();
    const shimDir = t.dir('gitshim');
    const compiled = spawnSync(
      CSC,
      [
        '/nologo',
        '/optimize',
        '/out:' + path.join(shimDir, 'git.exe'),
        path.join(gen.launchPath, 'sandbox', 'gitshim.cs'),
      ],
      { encoding: 'utf8' },
    );
    t.check(
      compiled.status === 0,
      'gitshim.cs compiles with the .NET Framework compiler',
      compiled.stdout + compiled.stderr,
    );
    if (compiled.status !== 0) return;

    const repo = t.dir('guard-repo');
    spawnSync(realGit, ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
    const guard = path.join(gen.launchPath, 'runtime', 'gitguard.js');
    const env = (access: string): NodeJS.ProcessEnv => ({
      ...process.env,
      PATH: shimDir + path.delimiter + process.env.PATH,
      AGENT_GIT_ACCESS: access,
      AGENT_REAL_GIT: access === 'readonly' ? realGit : '',
      AGENT_GUARD_NODE: process.execPath,
      AGENT_GUARD_SCRIPT: guard,
      GIT_CONFIG_NOSYSTEM: '1',
    });
    // `git` is found through PATH, where the shim comes first (that is the point of the test).
    const git = (access: string, args: string[]) =>
      spawnSync('git', args, { cwd: repo, env: env(access), encoding: 'utf8' });

    t.section('git.exe stand-in');
    const status = git('readonly', ['status', '--porcelain']);
    t.check(
      status.status === 0 && status.stdout.includes('a.txt'),
      'readonly: `git status` works through the git.exe stand-in (exact arguments preserved)',
      'exit ' + status.status + ' ' + status.stdout + status.stderr,
    );
    const add = git('readonly', ['add', 'a.txt']);
    t.check(add.status === 128, 'readonly: `git add` is refused with exit code 128', 'exit ' + add.status);
    t.includes(add.stderr, 'read-only', 'readonly: the refusal says why');
    t.includes(
      git('readonly', ['status', '--porcelain']).stdout,
      '??',
      'readonly: after the refused `git add` nothing has changed',
    );
    const none = git('none', ['status']);
    t.check(
      none.status === 128 && none.stderr.includes('disabled'),
      'none: every git call is refused',
      'exit ' + none.status + ' ' + none.stderr,
    );

    t.section('Git Bash');
    const gitRoot = path.dirname(path.dirname(realGit));
    const bash = [path.join(gitRoot, 'bin', 'bash.exe'), path.join(gitRoot, 'usr', 'bin', 'bash.exe')].find((b) =>
      fs.existsSync(b),
    );
    if (!bash) {
      t.skip('Git Bash check (no bash.exe next to git)');
      return;
    }
    const posix = (p: string): string => p.replace(/\\/g, '/');
    const bashEnv = t.write(
      t.at('gitshim', 'bashenv.sh'),
      'git() { "' + posix(process.execPath) + '" "' + posix(guard) + '" "$@"; }\nexport -f git\n',
    );
    const viaBash = spawnSync(bash, ['-c', 'git commit -m x'], {
      cwd: repo,
      env: { ...env('readonly'), BASH_ENV: posix(bashEnv) },
      encoding: 'utf8',
    });
    t.check(
      viaBash.status === 128 && viaBash.stderr.includes('read-only'),
      'readonly: git inside Git Bash goes through the guard too (BASH_ENV)',
      'exit ' + viaBash.status + ' ' + viaBash.stderr,
    );
  },
};
