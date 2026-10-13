// Zero-click protection for the folder the sandbox shares with this PC. What the agent writes there could run code on
// THIS PC without you doing anything unusual (git hooks and config, commands planted in the project root, agent and
// editor files), so it is snapshotted before launch, re-checked every minute and at close, and neutralised (RULES).
import { assertTestWritable } from '../test-guard.js';
import { AgentFilesRule, agentSnapshot } from './agent-files.js';
import { PlantedCommandsRule, plantedCommands } from './commands.js';
import { GitDirRule, gitState, plainGitDir } from './git-dirs.js';
import { NestedReposRule, nestedRepoStates } from './nested-repos.js';
import type { GuardRule, RepoFinding, RepoSnapshot } from './types.js';

/** The checks in the order their findings are reported. */
const RULES: readonly GuardRule[] = [
  new PlantedCommandsRule(),
  new AgentFilesRule(),
  new NestedReposRule(),
  new GitDirRule(),
];

/** Snapshots a project before the sandbox can write it, and later neutralises what it added. */
export class RepoGuard {
  snapshot(workspace: string): RepoSnapshot {
    const dir = plainGitDir(workspace);
    return {
      gitDir: dir !== null,
      ...gitState(dir),
      commands: plantedCommands(workspace),
      agent: agentSnapshot(workspace),
      repos: nestedRepoStates(workspace),
    };
  }

  /**
   * Compares the workspace with its pre-launch snapshot and neutralises anything new that would execute on this PC.
   * Returns what was found (and fixed). Never touches what was already there before the sandbox ran.
   */
  guard(workspace: string, before: RepoSnapshot): RepoFinding[] {
    assertTestWritable(workspace);
    return RULES.flatMap((rule) => rule.check(workspace, before));
  }
}
