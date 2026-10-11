// Runs every command and shortcut binary as a separate process in a simulated HOST: none of the sandbox-only folders
// or variables exist (C:\AgentLaunch, C:\AgentData, CLAUDE_CONFIG_DIR, ...), with a fresh home and storage. Tests
// usually run inside a sandbox, where those exist, so this is what catches code that only works there. Every command
// must either succeed or fail with a friendly "Error:" message; a crash or stack trace fails.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDir } from '../core/util.js';
import type { Harness } from './harness.js';

const SANDBOX_ONLY_VARS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'AGENT_WORKSPACE', 'AGENT_DATA', 'AGENT_TOOLS', 'AGENT_PROJECT', 'NVM_HOME', 'NVM_SYMLINK', 'BASH_ENV', 'CLAUDE_CODE_GIT_BASH_PATH', 'AGENT_GIT_ACCESS', 'AGENT_REAL_GIT', 'AGENT_SANDBOX_CONFIG'];

export const hostTests = (t: Harness): void => {
  t.section('simulated host: every command, outside a sandbox');
  const home = path.join(t.temp, 'host-sim-home');
  const project = path.join(t.temp, 'host-sim-project');
  const storage = path.join(t.temp, 'host-sim-storage');
  for (const dir of [home, project, storage]) ensureDir(dir);
  const config = t.write(path.join(t.temp, 'host-sim-config.json'), JSON.stringify({ storage: { root: storage }, personalization: { enabled: false }, provisioning: { terminal: { enabled: false } } }));
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !SANDBOX_ONLY_VARS.includes(k))),
    AGENT_SANDBOX_HOME: home,
    AGENT_LAUNCH_DIR: path.join(t.temp, 'no-agent-launch'),
    AGENT_DATA_DIR: path.join(t.temp, 'no-agent-data'),
    AGENT_HOST_TOOLS_DIR: path.join(t.temp, 'no-host-tools'),
    NO_COLOR: '1',
    // This test may itself run inside a sandbox: the CLI must behave as it would on a PC.
    AGENT_SANDBOX_HOST_ONLY: '1',
  };
  const bin = (name: string): string => path.join(t.packageRoot, 'dist', 'bin', name + '.js');
  const runs: [string, string, string[]][] = [
    ['agent-sandbox', '--help', ['--help']],
    ['agent-sandbox', 'status', ['status', '--config', config]],
    ['agent-sandbox', 'status --json', ['status', '--json', '--config', config]],
    ['agent-sandbox', 'sessions', ['sessions', '--config', config]],
    ['agent-sandbox', 'doctor', ['doctor', '--config', config]],
    ['agent-sandbox', 'account list', ['account', 'list', '--config', config]],
    ['agent-sandbox', 'account use nobody', ['account', 'use', 'nobody', '--config', config]],
    ['agent-sandbox', 'config path', ['config', 'path']],
    ['agent-sandbox', 'config show', ['config', 'show', '--config', config]],
    ['agent-sandbox', 'config schema', ['config', 'schema']],
    ['agent-sandbox', 'config init', ['config', 'init']],
    ['agent-sandbox', 'config init (again)', ['config', 'init']],
    ['agent-sandbox', 'clean', ['clean', '--config', config]],
    ['agent-sandbox', 'sync', ['sync', '--config', config]],
    ['agent-sandbox', 'logs', ['logs', '--config', config]],
    ['agent-sandbox', 'attach', ['attach', '--config', config]],
    ['agent-sandbox', 'exec', ['exec', '--config', config, '--', 'echo', 'hi']],
    ['agent-sandbox', 'restart', ['restart', '--config', config]],
    ['agent-sandbox', 'stop', ['stop', '--config', config]],
    ['agent-sandbox', 'show', ['show', '--config', config]],
    ['agent-sandbox', 'hide', ['hide', '--config', config]],
    ['agent-sandbox', 'generate', ['generate', '--config', config]],
    ['agent-sandbox', 'launch', ['launch', '--config', config]],
    ['agent-sandbox', 'unknown command', ['frobnicate']],
    ['claude-sbx', 'claude-sbx --headless --continue', ['--headless', '--continue', '--config', config]],
    ['codex-sbx', 'codex-sbx', ['--config', config]],
    ['gemini-sbx', 'gemini-sbx', ['--config', config]],
    ['sbx-show', 'sbx-show', ['--config', config]],
    ['claude-host', 'claude-host --version', ['--version']],
  ];
  const broken: string[] = [];
  for (const [name, label, args] of runs) {
    const r = spawnSync(process.execPath, [bin(name), ...args], { cwd: project, env, encoding: 'utf8', timeout: 120000 });
    const output = ((r.stdout ?? '') + (r.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '');
    const crashed = r.status === null || r.status > 1 || /Unexpected error|node:internal|^\s+at .+:\d+:\d+\)?$/m.test(output);
    const unexplained = r.status === 1 && !/(^|\n)(Error: |error: )/.test(output) && name !== 'claude-host';
    if (crashed || unexplained) broken.push(label + ' (exit ' + r.status + '): ' + output.trim().split('\n').slice(0, 4).join(' | '));
  }
  t.check(broken.length === 0, 'all ' + runs.length + ' commands work or fail with a clear message when run outside a sandbox' + (broken.length ? ':\n    ' + broken.join('\n    ') : ''));
  t.check(fs.existsSync(path.join(home, 'config.json')) && fs.existsSync(path.join(home, 'config.schema.json')) && fs.existsSync(path.join(home, 'sandbox-config.schema.json')), 'on a fresh PC, config init and the local schema files are created');
};
