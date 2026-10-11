// A fake "host PC" inside the temp folder: Node, claude.exe, a ~/.claude profile, workspaces, and helpers to resolve,
// generate and run the guest against it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Config, HostProbe, ResolvedRun, RunRequest } from '../core/types.js';
import { DEFAULTS } from '../core/config.js';
import { generateSandbox } from '../host/generate.js';
import { ensureDir } from '../core/util.js';
import { resolveRun } from '../core/workspace.js';
import type { Harness } from './harness.js';

export const HOST_NODE_VERSION = 'v22.3.0';

export const createFixtures = (t: Harness) => {
  const { temp, write } = t;
  const at = (...parts: string[]): string => path.join(temp, ...parts);
  const hostNode = at('host-node');
  write(path.join(hostNode, 'node.exe'), 'x');
  write(path.join(hostNode, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
  const hostClaude = at('host-claude');
  write(path.join(hostClaude, 'claude.exe'), 'fake-claude');
  const hostProfile = at('host-dot-claude');
  write(path.join(hostProfile, 'settings.json'), '{ "theme": "dark" }');
  write(path.join(hostProfile, 'CLAUDE.md'), 'my rules');
  write(path.join(hostProfile, 'commands', 'review.md'), 'review cmd');
  write(path.join(hostProfile, 'plugins', 'installed_plugins.json'), JSON.stringify({ path: hostProfile + '\\plugins\\cache\\claude-mem' }));
  write(path.join(hostProfile, '.credentials.json'), '{ "token": "secret" }');
  const hostGlobalState = write(at('host-claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { github: { command: 'npx' } } }));
  const install = at('install');
  ensureDir(path.join(install, 'sub'));
  const workA = at('work-a');
  const workB = at('work-b');
  const shared = at('shared');
  for (const d of [workA, workB, shared, path.join(workB, 'assets'), at('storage')]) ensureDir(d);
  write(path.join(workB, 'setup.mjs'), "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.AGENT_DATA, 'hook-ran.txt'), process.env.AGENT_WORKSPACE);\n");
  write(at('host-tools', 'agents', 'claude', 'claude.exe'), 'fake-claude');

  const makeConfig = (copyFromHost = true): Config => {
    const c = structuredClone(DEFAULTS);
    c.storage.root = at('storage');
    c.storage.dataName = 'testdata';
    c.sandbox.memoryMb = 8192;
    c.provisioning.copyFromHost = copyFromHost;
    c.provisioning.terminal.enabled = false;
    c.harnesses.claude.hostDir = hostClaude;
    c.claudeProfile = { ...c.claudeProfile, hostDir: hostProfile, globalStateFile: hostGlobalState };
    c.personalization.enabled = false;
    c.mappings = [{ host: at('missing-optional'), guest: 'C:\\GameSources\\Missing', readOnly: true, optional: true }];
    return c;
  };
  const baseConfig = makeConfig();
  const probe: HostProbe = { nodeDir: hostNode, harnessExe: { dir: hostClaude, file: 'claude.exe' }, gitDir: null, nvmDir: null, hostNodeVersion: HOST_NODE_VERSION };

  const run = (over: Partial<RunRequest> = {}, config: Config = baseConfig): Promise<ResolvedRun> =>
    resolveRun({ packageRoot: install, loaded: { config, configPath: null, base: temp }, cwd: workA, noAgent: false, noLocalConfig: false, trustConfig: false, scripts: [], ...over }, HOST_NODE_VERSION);

  const generate = (r: ResolvedRun, args: string[] = [], p: HostProbe = probe): ReturnType<typeof generateSandbox> =>
    generateSandbox({ packageRoot: t.packageRoot, run: r, harnessArgs: args, probe: p });

  const writeLocal = (dir: string, content: unknown): void => { write(path.join(dir, '.sandbox-config.json'), typeof content === 'string' ? content : JSON.stringify(content)); };

  /** Runs the guest's bundled main.js in dry-run mode against fake sandbox folders. */
  const runGuest = (launchPath: string, data: string, workspace: string, extra: Record<string, string> = {}): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, [path.join(launchPath, 'runtime', 'main.js')], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_LAUNCH_DIR: launchPath, AGENT_DATA_DIR: data, AGENT_HOST_TOOLS_DIR: at('host-tools'), AGENT_WORKSPACE: workspace, AGENT_LOCAL_DIR: at('local'), AGENT_MANAGED_DIR: at('managed'), AGENT_DRY_RUN: '1', ...extra },
    });
    return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };

  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { at, hostNode, hostClaude, hostProfile, hostGlobalState, install, workA, workB, shared, makeConfig, baseConfig, probe, run, generate, writeLocal, runGuest, readJson };
};

export type Fixtures = ReturnType<typeof createFixtures>;
