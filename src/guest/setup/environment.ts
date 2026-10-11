// The environment every agent session, hook and terminal tab in the sandbox gets.
import path from 'node:path';
import type { ToolEnv } from '../toolchains/index.js';
import { claudeDir, dataDir, dryRun, errMsg, isWin, testMode, mkdirp, powershell, session, stateDir, toolsDir, warn, workspace } from '../env.js';

/** Variables agent-sandbox itself sets (besides the toolchains' own). */
const AGENT_VARS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'npm_config_cache', 'npm_config_update_notifier', 'AGENT_WORKSPACE', 'AGENT_DATA', 'AGENT_TOOLS', 'AGENT_PROJECT'];

export const agentEnv = (tools: Pick<ToolEnv, 'vars' | 'prepend' | 'append'>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...tools.vars,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: path.join(stateDir, 'codex'),
    GEMINI_CLI_HOME: path.join(stateDir, 'gemini'),
    npm_config_cache: path.join(toolsDir, 'npm-cache'),
    npm_config_update_notifier: 'false',
    AGENT_WORKSPACE: workspace,
    AGENT_DATA: dataDir,
    AGENT_TOOLS: toolsDir,
    AGENT_PROJECT: session.project,
  };
  for (const dir of [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.GEMINI_CLI_HOME, env.npm_config_cache]) mkdirp(dir as string);
  // The runner's own Node (bootstrap.ps1 puts it first on PATH) is not exposed: `node` is whatever nvm selected.
  const runners = [path.join(toolsDir, 'node'), path.dirname(process.execPath)].map((d) => d.toLowerCase());
  const base = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && !runners.includes(d.toLowerCase()));
  env.PATH = [...new Set([...tools.prepend, ...base, ...tools.append])].join(path.delimiter);
  return env;
};

/** Makes the agent environment machine-wide, so new terminal tabs and anything the agent starts see the same tools. */
export const persistEnvironment = (env: NodeJS.ProcessEnv, toolVars: string[]): void => {
  if (!isWin || dryRun || testMode) return;
  const vars = Object.fromEntries([...toolVars, ...AGENT_VARS].filter((n) => env[n] !== undefined).map((n) => [n, env[n] as string]));
  const script = [
    "$vars = '" + JSON.stringify(vars).replace(/'/g, "''") + "' | ConvertFrom-Json",
    "foreach ($p in $vars.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, 'Machine') }",
    "[Environment]::SetEnvironmentVariable('Path', '" + (env.PATH ?? '').replace(/'/g, "''") + "', 'Machine')",
  ].join('\n');
  try { powershell(script); } catch (e) { warn('Could not persist the environment machine-wide: ' + errMsg(e)); }
};
