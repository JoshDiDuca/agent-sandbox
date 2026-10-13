// The environment every agent session, hook and terminal tab in the sandbox gets.
import path from 'node:path';
import type { ToolEnv } from '../toolchains/index.js';
import { claudeDir, session, stateDir, workspace } from '../runtime/session.js';
import { dataDir, dryRun, isWin, testMode, toolsDir } from '../runtime/paths.js';
import { mkdirp } from '../runtime/fs.js';
import { runScriptWithJson } from '../runtime/process.js';
import { warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';

/** Variables agent-sandbox itself sets (besides the toolchains' own). */
const AGENT_VARS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GEMINI_CLI_HOME',
  'npm_config_cache',
  'npm_config_update_notifier',
  'AGENT_WORKSPACE',
  'AGENT_DATA',
  'AGENT_TOOLS',
  'AGENT_PROJECT',
  'AGENT_SANDBOX',
  'AGENT_SANDBOX_WORKSPACE',
];

/** Whose environment: the launch folder's at boot, or a project registered later (with the boot's base environment). */
export interface EnvTarget {
  workspace: string;
  project: string;
  base: NodeJS.ProcessEnv;
}

export const agentEnv = (
  tools: Pick<ToolEnv, 'vars' | 'prepend' | 'append'>,
  target: EnvTarget = { workspace, project: session.project, base: process.env },
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...target.base,
    ...tools.vars,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: path.join(stateDir, 'codex'),
    GEMINI_CLI_HOME: path.join(stateDir, 'gemini'),
    npm_config_cache: path.join(toolsDir, 'npm-cache'),
    npm_config_update_notifier: 'false',
    AGENT_WORKSPACE: target.workspace,
    AGENT_DATA: dataDir,
    AGENT_TOOLS: toolsDir,
    AGENT_PROJECT: target.project,
    // For project scripts: "am I in the sandbox, and where is the project?" (stable names; documented).
    AGENT_SANDBOX: '1',
    AGENT_SANDBOX_WORKSPACE: target.workspace,
  };
  for (const dir of [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.GEMINI_CLI_HOME, env.npm_config_cache])
    mkdirp(dir as string);
  // The runner's own Node (bootstrap.ps1 puts it first on PATH) is not exposed: `node` is whatever nvm selected.
  const runners = [path.join(toolsDir, 'node'), path.dirname(process.execPath)].map((d) => d.toLowerCase());
  const base = (target.base.PATH ?? '').split(path.delimiter).filter((d) => d && !runners.includes(d.toLowerCase()));
  env.PATH = [...new Set([...tools.prepend, ...base, ...tools.append])].join(path.delimiter);
  return env;
};

/** Makes the agent environment machine-wide, so new terminal tabs and anything the agent starts see the same tools. */
export const persistEnvironment = (env: NodeJS.ProcessEnv, toolVars: string[]): void => {
  if (!isWin || dryRun || testMode) return;
  const vars = Object.fromEntries(
    [...toolVars, ...AGENT_VARS].filter((n) => env[n] !== undefined).map((n) => [n, env[n] as string]),
  );
  try {
    runScriptWithJson('set-machine-environment.ps1', 'SettingsFile', {
      vars,
      path: env.PATH ?? '',
      add: [],
      additive: false,
    });
  } catch (e) {
    warn('Could not persist the environment machine-wide: ' + errMsg(e));
  }
};

/**
 * Adds variables and PATH folders machine-wide after boot (`sbx-db start`): new terminal tabs see them.
 * additive: for a project registered later. Only variables not set yet, and folders go to the END of PATH, so what
 * the boot project's terminals see never changes; the project's own sessions get its full environment anyway.
 */
export const addMachineEnvironment = (vars: Record<string, string>, dirs: string[], additive = false): void => {
  if (!isWin || dryRun || testMode) return;
  try {
    runScriptWithJson('set-machine-environment.ps1', 'SettingsFile', { vars, path: null, add: dirs, additive });
  } catch (e) {
    warn('Could not add to the environment: ' + errMsg(e));
  }
};
