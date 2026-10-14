// Repository guard (zero-click code execution on this PC): after the sandbox ran, hooks, program-running git config
// and commands planted in the repository are quarantined before anything on this PC can run them.
import fs from 'node:fs';
import path from 'node:path';
import { isMarked, markFromSandbox, RepoGuard, watchAndMark } from '../host/guard/index.js';
import type { Suite } from './support/suite.js';

const repoGuard = new RepoGuard();

export const repoGuardSuite: Suite = {
  name: 'repo-guard',
  title: 'repository guard (hooks, git config, planted commands, replaced .git)',
  run: async (t) => {
    const readConfig = (repo: string): string => fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
    const disabled = (keyPattern: string): RegExp => new RegExp('# \\[agent-sandbox\\] disabled.*' + keyPattern);

    t.section('hooks and git config');
    const repo = t.at('repo');
    t.write(
      path.join(repo, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://example.com/x.git\n',
    );
    t.write(path.join(repo, '.git', 'hooks', 'pre-commit.sample'), 'sample');
    t.write(path.join(repo, '.git', 'hooks', 'pre-push'), 'existing hook');
    const before = repoGuard.snapshot(repo)!;
    t.write(path.join(repo, '.git', 'hooks', 'post-checkout'), 'calc.exe');
    t.write(path.join(repo, '.git', 'hooks', 'pre-push'), 'changed hook');
    fs.appendFileSync(
      path.join(repo, '.git', 'config'),
      '[core]\n\tfsmonitor = calc.exe\n\tsshCommand = evil\n[include]\n\tpath = C:/evil.cfg\n[branch "feature"]\n\tremote = origin\n',
    );
    const findings = repoGuard.guard(repo, before);
    t.check(
      !fs.existsSync(path.join(repo, '.git', 'hooks', 'post-checkout')) &&
        !fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-push')) &&
        fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit.sample')) &&
        findings.filter((x) => x.kind === 'hook').length === 2,
      'new and changed git hooks are quarantined and reported; samples are left alone',
    );
    const config = readConfig(repo);
    t.check(
      disabled('fsmonitor').test(config) &&
        disabled('sshCommand').test(config) &&
        disabled('path = C:/evil').test(config) &&
        /^\tremote = origin$/m.test(config) &&
        /^\turl = https/m.test(config),
      'git config: fsmonitor, sshCommand and an [include] of an outside file are disabled; harmless lines stay',
      config,
    );
    t.equal(repoGuard.guard(repo, before).length, 0, 'the guard is idempotent');

    t.section('planted commands and tricks');
    const repo2 = t.at('repo2');
    t.write(path.join(repo2, '.git', 'config'), '[core]\n\tbare = false\n');
    t.write(path.join(repo2, 'build.cmd'), 'echo legit');
    const before2 = repoGuard.snapshot(repo2);
    const planted = ['node.exe', 'git.cmd', 'sandbox.cmd', 'opencode.ps1'];
    for (const name of planted) t.write(path.join(repo2, name), name === 'node.exe' ? 'MZ' : 'calc');
    t.write(path.join(repo2, '.git', 'commondir'), 'C:/evil');
    fs.appendFileSync(path.join(repo2, '.git', 'config'), '[core] fsmonitor = calc.exe\n');
    const found2 = repoGuard.guard(repo2, before2);
    t.check(
      planted.every((name) => !fs.existsSync(path.join(repo2, name))) &&
        fs.existsSync(path.join(repo2, 'build.cmd')) &&
        found2.filter((x) => x.kind === 'command').length === 4 &&
        !fs.existsSync(path.join(repo2, '.git', 'commondir')) &&
        disabled('fsmonitor').test(readConfig(repo2)),
      'executables planted under command names are quarantined (other scripts stay), a planted commondir is removed, a key on a [section] line is neutralised',
    );

    t.section('a replaced or oversized .git');
    const victim = t.dir('repo-victim');
    const repo3 = t.at('repo3');
    t.write(path.join(repo3, '.git', 'config'), '[core]\n');
    const before3 = repoGuard.snapshot(repo3);
    fs.rmSync(path.join(repo3, '.git'), { recursive: true });
    fs.symlinkSync(victim, path.join(repo3, '.git'), 'junction');
    const repo4 = t.at('repo4');
    t.write(path.join(repo4, '.git', 'config'), '[core]\n');
    const before4 = repoGuard.snapshot(repo4);
    fs.appendFileSync(path.join(repo4, '.git', 'config'), '#'.repeat(5 * 1024 * 1024));
    t.check(
      repoGuard.guard(repo3, before3).some((x) => x.kind === 'git' && x.detail.includes('replaced')) &&
        repoGuard.guard(repo4, before4).some((x) => x.kind === 'git' && x.detail.includes('over 4 MB')),
      '.git replaced by a link, or a git config too big to check, is reported instead of passing',
    );

    t.section('more git config that runs programs');
    const repo5 = t.at('repo5');
    t.write(path.join(repo5, '.git', 'config'), '[alias]\n\tst = status\n');
    const before5 = repoGuard.snapshot(repo5);
    fs.appendFileSync(
      path.join(repo5, '.git', 'config'),
      '[alias]\n\tlg = !calc.exe\n\tco = checkout\n[pager]\n\tlog = calc.exe\n[diff]\n\texternal = calc.exe\n',
    );
    repoGuard.guard(repo5, before5);
    const config5 = readConfig(repo5);
    t.check(
      disabled('lg = !calc').test(config5) &&
        /^\tco = checkout$/m.test(config5) &&
        disabled('log = calc').test(config5) &&
        disabled('external = calc').test(config5),
      'git config: aliases that run a program (!), [pager] and diff.external are disabled; a plain alias stays',
      config5,
    );

    t.section('submodules and nested repositories');
    const repo6 = t.at('repo6');
    t.write(path.join(repo6, '.git', 'config'), '[core]\n');
    t.write(path.join(repo6, '.git', 'modules', 'lib', 'config'), '[core]\n');
    t.write(path.join(repo6, '.git', 'modules', 'lib', 'HEAD'), 'ref: refs/heads/main\n');
    t.write(path.join(repo6, 'tools', 'inner', '.git', 'config'), '[core]\n');
    const before6 = repoGuard.snapshot(repo6);
    t.write(path.join(repo6, '.git', 'modules', 'lib', 'hooks', 'post-checkout'), 'calc.exe');
    fs.appendFileSync(path.join(repo6, 'tools', 'inner', '.git', 'config'), '\tfsmonitor = calc.exe\n');
    t.write(path.join(repo6, 'other', '.git', 'hooks', 'pre-commit'), 'calc.exe');
    const findings6 = repoGuard.guard(repo6, before6);
    t.check(
      !fs.existsSync(path.join(repo6, '.git', 'modules', 'lib', 'hooks', 'post-checkout')) &&
        disabled('fsmonitor').test(fs.readFileSync(path.join(repo6, 'tools', 'inner', '.git', 'config'), 'utf8')) &&
        !fs.existsSync(path.join(repo6, 'other', '.git', 'hooks', 'pre-commit')) &&
        findings6.some((f) => f.detail.startsWith('tools/inner/.git: ')),
      'hooks in submodules, config of nested repositories and hooks of repositories created in the sandbox are handled, findings name the repository',
    );
    const legacy = { ...before6, repos: undefined, agent: undefined };
    t.write(path.join(repo6, 'third', '.git', 'hooks', 'pre-commit'), 'yours');
    repoGuard.guard(repo6, legacy);
    t.check(
      fs.existsSync(path.join(repo6, 'third', '.git', 'hooks', 'pre-commit')),
      'a snapshot from an older version (no baseline) never moves your files',
    );

    t.section('agent and editor files');
    const repo7 = t.at('repo7');
    t.write(path.join(repo7, '.claude', 'settings.local.json'), '{ "permissions": { "allow": ["Bash(npm test)"] } }');
    t.write(path.join(repo7, '.vscode', 'settings.json'), '{\n  // comment\n  "editor.tabSize": 2\n}');
    const before7 = repoGuard.snapshot(repo7);
    t.write(
      path.join(repo7, '.claude', 'settings.local.json'),
      '{ "permissions": { "allow": ["Bash(npm test)", "Bash(npm run lint)"] } }',
    );
    t.write(path.join(repo7, '.vscode', 'settings.json'), '{\n  "editor.tabSize": 4,\n}');
    t.equal(repoGuard.guard(repo7, before7), [], 'ordinary edits (permissions, editor settings) are left alone');
    t.write(
      path.join(repo7, '.claude', 'settings.json'),
      '{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "calc.exe" }] }] } }',
    );
    t.write(path.join(repo7, '.mcp.json'), '{ "mcpServers": { "x": { "command": "calc.exe" } } }');
    t.write(
      path.join(repo7, '.vscode', 'tasks.json'),
      '{ "tasks": [{ "label": "x", "command": "calc.exe", "runOptions": { "runOn": "folderOpen" } }] }',
    );
    t.write(path.join(repo7, '.vscode', 'settings.json'), '{ "python.defaultInterpreterPath": "C:\\\\evil.exe" }');
    const findings7 = repoGuard.guard(repo7, before7);
    t.check(
      findings7.filter((f) => f.kind === 'agent').length === 4 &&
        !fs.existsSync(path.join(repo7, '.mcp.json')) &&
        fs.existsSync(path.join(repo7, '.claude', 'settings.local.json')),
      'Claude hooks, MCP servers, folder-open tasks and program paths in VS Code settings are quarantined, nothing else',
    );

    t.section('programs from the sandbox are marked');
    const marked = t.at('marked');
    t.write(path.join(marked, 'setup.ps1'), 'calc');
    t.write(path.join(marked, 'src', 'app.ts'), 'code');
    t.check(
      markFromSandbox(path.join(marked, 'setup.ps1')) &&
        isMarked(path.join(marked, 'setup.ps1')) &&
        !markFromSandbox(path.join(marked, 'src', 'app.ts')) &&
        !isMarked(path.join(marked, 'src', 'app.ts')) &&
        fs.readFileSync(path.join(marked, 'setup.ps1'), 'utf8') === 'calc',
      'a script gets the "from the internet" mark (the file itself is never written); source files are left alone',
    );
    const stop = watchAndMark([marked]);
    t.write(path.join(marked, 'bin', 'tool.exe'), 'MZ');
    const live = await t.waitFor(() => isMarked(path.join(marked, 'bin', 'tool.exe')), 5000);
    stop();
    t.check(Boolean(live), 'while it watches, a program that appears is marked within a second or two');
  },
};
