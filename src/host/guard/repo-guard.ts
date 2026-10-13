// Zero-click protection for the folder the sandbox shares with this PC.
//
// The agent can write the workspace. Two kinds of change there would run code on THIS PC without you doing anything
// unusual, so they are snapshotted before launch, re-checked every minute while the sandbox runs and when it closes,
// and neutralised:
//  - git: new or changed hooks, and config that makes git run programs (core.fsmonitor, core.sshCommand, filters,
//    include.path, ...), plus files that redirect where git reads config and hooks (commondir, config.worktree);
//  - commands: executables dropped in the project root under the name of something you type there (node.exe,
//    git.cmd, npm.cmd, ...), because Windows runs a program from the current folder before searching PATH;
//  - agent and editor files: hooks, helper commands and MCP servers in .claude/ and .mcp.json, VS Code folder-open
//    tasks and program paths, .envrc. Submodules and nested repositories get the git checks too.
import fs from 'node:fs';
import path from 'node:path';
import { assertTestWritable } from '../test-guard.js';
import { plainGitDir, gitState, filesIn, otherGitDirs, guardGitDir, EMPTY_GIT } from './git-dirs.js';
import { COMMANDS } from './commands.js';
import { agentSnapshot, guardAgentFiles } from './agent-files.js';
import { quarantine } from './quarantine.js';

/** A git folder's own state: config lines, hooks, redirect files. */
export interface GitState {
  config: string[];
  hooks: Record<string, string>;
  redirects: string[];
}
export interface RepoSnapshot extends GitState {
  gitDir: boolean;
  commands: Record<string, string>;
  /** Fingerprints of AGENT_FILES (missing in snapshots of older versions: then they are not checked). */
  agent?: Record<string, string>;
  /** Other git folders: submodules (.git/modules/...) and repositories nested in the project, by relative path. */
  repos?: Record<string, GitState>;
}
export interface RepoFinding {
  kind: 'hook' | 'config' | 'git' | 'command' | 'agent';
  detail: string;
}
const relative = (workspace: string, dir: string): string => path.relative(workspace, dir).split(path.sep).join('/');

export const snapshotRepo = (workspace: string): RepoSnapshot => {
  const dir = plainGitDir(workspace);
  return {
    gitDir: dir !== null,
    ...gitState(dir),
    commands: filesIn(workspace, (n) => COMMANDS.test(n)),
    agent: agentSnapshot(workspace),
    repos: Object.fromEntries(otherGitDirs(workspace).map((d) => [relative(workspace, d), gitState(d)])),
  };
};

/**
 * Compares the workspace with its pre-launch snapshot and neutralises anything new that would execute on this PC.
 * Returns what was found (and fixed). Never touches what was already there before the sandbox ran.
 */
export const guardRepo = (workspace: string, before: RepoSnapshot): RepoFinding[] => {
  assertTestWritable(workspace);
  const findings: RepoFinding[] = [];
  const commandsNow = filesIn(workspace, (n) => COMMANDS.test(n));
  findings.push(
    ...quarantine(
      workspace,
      Object.keys(commandsNow).filter((n) => before.commands[n] !== commandsNow[n]),
      workspace,
      'command',
    ),
  );

  // Snapshots from before these checks existed have no baseline: checking against nothing would move your own files.
  if (before.agent) findings.push(...guardAgentFiles(workspace, before.agent));
  if (before.repos) {
    for (const other of otherGitDirs(workspace)) {
      const rel = relative(workspace, other);
      findings.push(
        ...guardGitDir(other, before.repos[rel] ?? EMPTY_GIT).map((f) => ({ ...f, detail: rel + ': ' + f.detail })),
      );
    }
  }

  const dir = plainGitDir(workspace);
  if (!dir) {
    const replaced = before.gitDir && fs.existsSync(path.join(workspace, '.git'));
    if (replaced)
      findings.push({
        kind: 'git',
        detail:
          '.git was replaced by a link or a "gitdir:" file inside the sandbox. Do not run git in ' +
          workspace +
          ' until you have checked it.',
      });
    return findings;
  }
  findings.push(...guardGitDir(dir, before));
  return findings;
};
