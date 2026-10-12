// Repository guard (zero-click code execution on this PC): after the sandbox ran, hooks, program-running git config
// and commands planted in the repository are quarantined before anything on this PC can run them.
import fs from 'node:fs';
import path from 'node:path';
import { guardRepo, snapshotRepo } from '../host/repo-guard.js';
import type { Suite } from './suite.js';

export const repoGuardSuite: Suite = {
  name: 'repo-guard',
  title: 'repository guard (hooks, git config, planted commands, replaced .git)',
  run: (t) => {
    const readConfig = (repo: string): string => fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
    const disabled = (keyPattern: string): RegExp => new RegExp('# \\[agent-sandbox\\] disabled.*' + keyPattern);

    t.section('hooks and git config');
    const repo = t.at('repo');
    t.write(path.join(repo, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://example.com/x.git\n');
    t.write(path.join(repo, '.git', 'hooks', 'pre-commit.sample'), 'sample');
    t.write(path.join(repo, '.git', 'hooks', 'pre-push'), 'existing hook');
    const before = snapshotRepo(repo)!;
    t.write(path.join(repo, '.git', 'hooks', 'post-checkout'), 'calc.exe');
    t.write(path.join(repo, '.git', 'hooks', 'pre-push'), 'changed hook');
    fs.appendFileSync(path.join(repo, '.git', 'config'), '[core]\n\tfsmonitor = calc.exe\n\tsshCommand = evil\n[include]\n\tpath = C:/evil.cfg\n[branch "feature"]\n\tremote = origin\n');
    const findings = guardRepo(repo, before);
    t.check(!fs.existsSync(path.join(repo, '.git', 'hooks', 'post-checkout')), 'a new git hook is quarantined');
    t.check(!fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-push')), 'a changed git hook is quarantined');
    t.check(fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit.sample')), 'hook samples are left alone');
    t.equal(findings.filter((x) => x.kind === 'hook').length, 2, 'both hooks are reported');
    const config = readConfig(repo);
    t.matches(config, disabled('fsmonitor'), 'git config: fsmonitor (runs a program) is disabled');
    t.matches(config, disabled('sshCommand'), 'git config: sshCommand is disabled');
    t.matches(config, disabled('path = C:/evil'), 'git config: [include] of an outside file is disabled');
    t.matches(config, /^\tremote = origin$/m, 'git config: a harmless change stays');
    t.matches(config, /^\turl = https/m, 'git config: existing lines stay');
    t.equal(guardRepo(repo, before).length, 0, 'the guard is idempotent');

    t.section('planted commands and tricks');
    const repo2 = t.at('repo2');
    t.write(path.join(repo2, '.git', 'config'), '[core]\n\tbare = false\n');
    t.write(path.join(repo2, 'build.cmd'), 'echo legit');
    const before2 = snapshotRepo(repo2);
    for (const name of ['node.exe', 'git.cmd', 'sandbox.cmd', 'opencode.ps1']) t.write(path.join(repo2, name), name === 'node.exe' ? 'MZ' : 'calc');
    t.write(path.join(repo2, '.git', 'commondir'), 'C:/evil');
    fs.appendFileSync(path.join(repo2, '.git', 'config'), '[core] fsmonitor = calc.exe\n');
    const found2 = guardRepo(repo2, before2);
    const gone = ['node.exe', 'git.cmd', 'sandbox.cmd', 'opencode.ps1'].filter((name) => !fs.existsSync(path.join(repo2, name)));
    t.equal(gone, ['node.exe', 'git.cmd', 'sandbox.cmd', 'opencode.ps1'], 'executables planted under command names are quarantined');
    t.check(fs.existsSync(path.join(repo2, 'build.cmd')), 'other scripts stay');
    t.equal(found2.filter((x) => x.kind === 'command').length, 4, 'every planted command is reported');
    t.check(!fs.existsSync(path.join(repo2, '.git', 'commondir')), 'a planted commondir is removed');
    t.matches(readConfig(repo2), disabled('fsmonitor'), 'a key on the same line as its [section] is neutralised');

    t.section('a replaced or oversized .git');
    const victim = t.dir('repo-victim');
    const repo3 = t.at('repo3');
    t.write(path.join(repo3, '.git', 'config'), '[core]\n');
    const before3 = snapshotRepo(repo3);
    fs.rmSync(path.join(repo3, '.git'), { recursive: true });
    fs.symlinkSync(victim, path.join(repo3, '.git'), 'junction');
    t.check(guardRepo(repo3, before3).some((x) => x.kind === 'git' && x.detail.includes('replaced')), '.git replaced by a link is reported loudly');
    const repo4 = t.at('repo4');
    t.write(path.join(repo4, '.git', 'config'), '[core]\n');
    const before4 = snapshotRepo(repo4);
    fs.appendFileSync(path.join(repo4, '.git', 'config'), '#'.repeat(5 * 1024 * 1024));
    t.check(guardRepo(repo4, before4).some((x) => x.kind === 'git' && x.detail.includes('over 4 MB')), 'a git config too big to check is reported instead of passing');

    t.section('more git config that runs programs');
    const repo5 = t.at('repo5');
    t.write(path.join(repo5, '.git', 'config'), '[alias]\n\tst = status\n');
    const before5 = snapshotRepo(repo5);
    fs.appendFileSync(path.join(repo5, '.git', 'config'), '[alias]\n\tlg = !calc.exe\n\tco = checkout\n[pager]\n\tlog = calc.exe\n[diff]\n\texternal = calc.exe\n');
    guardRepo(repo5, before5);
    const config5 = readConfig(repo5);
    t.matches(config5, disabled('lg = !calc'), 'git config: an alias that runs a program (!) is disabled');
    t.matches(config5, /^\tco = checkout$/m, 'git config: a plain alias stays');
    t.matches(config5, disabled('log = calc'), 'git config: [pager] entries are disabled');
    t.matches(config5, disabled('external = calc'), 'git config: diff.external is disabled');

    t.section('submodules and nested repositories');
    const repo6 = t.at('repo6');
    t.write(path.join(repo6, '.git', 'config'), '[core]\n');
    t.write(path.join(repo6, '.git', 'modules', 'lib', 'config'), '[core]\n');
    t.write(path.join(repo6, '.git', 'modules', 'lib', 'HEAD'), 'ref: refs/heads/main\n');
    t.write(path.join(repo6, 'tools', 'inner', '.git', 'config'), '[core]\n');
    const before6 = snapshotRepo(repo6);
    t.write(path.join(repo6, '.git', 'modules', 'lib', 'hooks', 'post-checkout'), 'calc.exe');
    fs.appendFileSync(path.join(repo6, 'tools', 'inner', '.git', 'config'), '\tfsmonitor = calc.exe\n');
    t.write(path.join(repo6, 'other', '.git', 'hooks', 'pre-commit'), 'calc.exe');
    const findings6 = guardRepo(repo6, before6);
    t.check(!fs.existsSync(path.join(repo6, '.git', 'modules', 'lib', 'hooks', 'post-checkout')), 'a hook planted in a submodule is quarantined');
    t.matches(fs.readFileSync(path.join(repo6, 'tools', 'inner', '.git', 'config'), 'utf8'), disabled('fsmonitor'), 'git config of a nested repository is checked too');
    t.check(!fs.existsSync(path.join(repo6, 'other', '.git', 'hooks', 'pre-commit')), 'a repository created inside the sandbox has no trusted hooks');
    t.check(findings6.some((f) => f.detail.startsWith('tools/inner/.git: ')), 'findings say which repository they are in');
    const legacy = { ...before6, repos: undefined, agent: undefined };
    t.write(path.join(repo6, 'third', '.git', 'hooks', 'pre-commit'), 'yours');
    guardRepo(repo6, legacy);
    t.check(fs.existsSync(path.join(repo6, 'third', '.git', 'hooks', 'pre-commit')), 'a snapshot from an older version (no baseline) never moves your files');

    t.section('agent and editor files');
    const repo7 = t.at('repo7');
    t.write(path.join(repo7, '.claude', 'settings.local.json'), '{ "permissions": { "allow": ["Bash(npm test)"] } }');
    t.write(path.join(repo7, '.vscode', 'settings.json'), '{\n  // comment\n  "editor.tabSize": 2\n}');
    const before7 = snapshotRepo(repo7);
    t.write(path.join(repo7, '.claude', 'settings.local.json'), '{ "permissions": { "allow": ["Bash(npm test)", "Bash(npm run lint)"] } }');
    t.write(path.join(repo7, '.vscode', 'settings.json'), '{\n  "editor.tabSize": 4,\n}');
    t.equal(guardRepo(repo7, before7), [], 'ordinary edits (permissions, editor settings) are left alone');
    t.write(path.join(repo7, '.claude', 'settings.json'), '{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "calc.exe" }] }] } }');
    t.write(path.join(repo7, '.mcp.json'), '{ "mcpServers": { "x": { "command": "calc.exe" } } }');
    t.write(path.join(repo7, '.vscode', 'tasks.json'), '{ "tasks": [{ "label": "x", "command": "calc.exe", "runOptions": { "runOn": "folderOpen" } }] }');
    t.write(path.join(repo7, '.vscode', 'settings.json'), '{ "python.defaultInterpreterPath": "C:\\\\evil.exe" }');
    const findings7 = guardRepo(repo7, before7);
    t.equal(findings7.filter((f) => f.kind === 'agent').length, 4, 'Claude hooks, MCP servers, folder-open tasks and program paths in VS Code settings are quarantined');
    t.check(!fs.existsSync(path.join(repo7, '.mcp.json')) && fs.existsSync(path.join(repo7, '.claude', 'settings.local.json')), '... and nothing else is moved');
  },
};
