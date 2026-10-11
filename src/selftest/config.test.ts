// Config loading, argument parsing, workspace resolution and .sandbox-config.json trust.
import fs from 'node:fs';
import path from 'node:path';
import { parseCli as parseArgs } from '../cli/args.js';
import { loadConfig } from '../core/config.js';
import { ensureDir } from '../core/util.js';
import { autoGuestWorkspace } from '../core/workspace.js';
import type { Fixtures } from './fixtures.js';
import type { Harness } from './harness.js';

export const configTests = async (t: Harness, f: Fixtures): Promise<void> => {
  const { check, rejects, write, temp } = t;

  t.section('config');
  const builtIn = loadConfig();
  check(builtIn.configPath === null && builtIn.config.guestWorkspace === 'auto' && !builtIn.config.sandbox.headless && !builtIn.config.sandbox.vGpu && builtIn.config.provisioning.git.access === 'full', 'no user config: built-in defaults (auto guest folder, headless off, vGPU off, git full)');
  const custom = loadConfig(write(path.join(temp, 'cfg.json'), JSON.stringify({ sandbox: { headless: true }, toolchains: { rust: { enabled: false } }, mappings: [{ host: 'rel-folder', guest: 'C:\\Rel', readOnly: true }] })));
  check(custom.config.sandbox.headless && !custom.config.toolchains.rust.enabled && custom.config.toolchains.python.enabled, 'a config file only needs the keys it changes (deep merge over defaults)');
  check(await rejects(() => loadConfig(path.join(temp, 'missing.json')), 'Config file not found'), 'an explicit --config that does not exist is an error');
  check(loadConfig(path.join(t.packageRoot, 'config.example.json')).config.defaultHarness === 'claude', 'config.example.json is valid');
  ensureDir(path.join(temp, 'rel-folder'));
  const relRun = await f.run({}, { ...custom.config, storage: f.baseConfig.storage });
  check(relRun.config.mappings.some((m) => m.host === path.join(temp, 'rel-folder')), 'relative mappings in the user config resolve against the config file\'s folder');

  t.section('arguments');
  const wrapped = parseArgs(['--terminal', '--continue', '--headless', '--node', '20', '--', '--terminal'], true);
  check(wrapped.command === 'launch' && wrapped.terminal && wrapped.headless === true && wrapped.node === '20' && wrapped.passthrough.join(' ') === '--continue --terminal', 'claude-sbx: sandbox flags are consumed, everything else goes to the agent');
  check(await rejects(() => parseArgs(['status', '--bogus']), 'unknown option') && parseArgs(['account', 'use', 'work', '--no-restart']).positionals.join() === 'use,work' && parseArgs(['clean', '--days=3']).days === 3, 'agent-sandbox: unknown options are errors; positionals and --opt=value work');
  const agentFlags = parseArgs(['--model', 'opus', '-p', 'fix it', '--json', '-f', 'x', '--timeout', '5', '--resume', 'abc'], true);
  check(agentFlags.passthrough.join(' ') === '--model opus -p fix it --json -f x --timeout 5 --resume abc' && !agentFlags.json && !agentFlags.follow && agentFlags.timeout === 600, 'claude-sbx: only launch options are ours; any other flag (even ones agent-sandbox uses elsewhere) goes to the agent, in order');
  const reserved = parseArgs(['--sbx-terminal', '--terminal', '--sbx-node=18'], true);
  check(reserved.terminal && reserved.node === '18' && reserved.passthrough.join(' ') === '' && parseArgs(['launch', '--continue', '--sbx-headless']).passthrough.join() === '--continue' && await rejects(() => parseArgs(['--sbx-nope'], true), 'Unknown option: --sbx-nope'), '--sbx-<option> always means agent-sandbox; agent-sandbox launch passes agent flags too');

  t.section('workspace');
  const rA = await f.run();
  check(rA.workspaceHost === f.workA && rA.config.guestWorkspace === 'C:\\Workspace\\work-a' && rA.harnessName === 'claude' && rA.dataPath.endsWith(path.join('data', 'testdata')), 'any folder is the workspace; guest path is C:\\Workspace\\<folder name>');
  check(autoGuestWorkspace('C:\\x\\My Proj (2)') === 'C:\\Workspace\\My Proj _2_' && autoGuestWorkspace('D:\\...') === 'C:\\Workspace\\project', 'auto guest folder names are sanitised');
  check(rA.versions.node.spec === '22.3.0' && rA.versions.node.source === 'this PC' && rA.versions.python.spec === '3', 'default Node version is this PC\'s; Python defaults to latest 3.x');
  write(path.join(f.workA, '.nvmrc'), 'lts/iron\n');
  write(path.join(f.workA, '.python-version'), '3.11\n');
  const rV = await f.run();
  check(rV.versions.node.spec === 'lts/iron' && rV.versions.node.source === '.nvmrc' && rV.versions.python.spec === '3.11', '.nvmrc and .python-version are respected');
  check((await f.run({ nodeVersion: '18' })).versions.node.source === 'command line', '--node beats .nvmrc');
  fs.rmSync(path.join(f.workA, '.nvmrc'));
  fs.rmSync(path.join(f.workA, '.python-version'));
  write(path.join(f.workA, '.node-version'), 'v20.11.1');
  check((await f.run()).versions.node.spec === 'v20.11.1', '.node-version is respected');
  fs.rmSync(path.join(f.workA, '.node-version'));

  check(await rejects(() => f.run({ cwd: f.install }), 'install folder') && await rejects(() => f.run({ cwd: temp }), 'must not be able to change') && await rejects(() => f.run({ cwd: path.join(temp, 'storage') }), 'storage folder'), 'refuses the install folder, its parents and the storage folder');
  const originalWindir = process.env.WINDIR;
  ensureDir(path.join(temp, 'winroot', 'sys'));
  process.env.WINDIR = path.join(temp, 'winroot');
  const sysRefused = await rejects(() => f.run({ cwd: path.join(temp, 'winroot', 'sys') }), 'system folder');
  process.env.WINDIR = originalWindir;
  check(sysRefused && await rejects(() => f.run({ cwd: path.parse(temp).root }), 'whole drive'), 'refuses system folders and drive roots');

  t.section('.sandbox-config.json');
  const localB = { harness: 'codex', sandbox: { memoryMb: 4096, networking: false, headless: true }, toolchains: { node: { version: '18' }, rust: { enabled: false } }, mappings: [{ host: './assets', guest: 'C:\\Assets', readOnly: true }, { host: '../shared', guest: 'C:\\Shared', readOnly: false }], scripts: ['./setup.mjs'] };
  f.writeLocal(f.workB, localB);
  check(await rejects(() => f.run({ cwd: f.workB }), '--trust-config') && await rejects(() => f.run({ cwd: f.workB }), 'READ/WRITE'), 'an untrusted .sandbox-config.json is refused and its effects are listed');
  check(await rejects(() => f.run({ cwd: f.workB, ask: async () => false }), 'has not been approved'), 'answering "no" refuses it');
  const rB = await f.run({ cwd: f.workB, ask: async () => true });
  check(rB.harnessName === 'codex' && rB.config.sandbox.memoryMb === 4096 && rB.config.sandbox.headless && !rB.config.toolchains.rust.enabled && rB.config.toolchains.python.enabled && rB.versions.node.source === '.sandbox-config.json', 'approved local settings apply over the defaults (incl. toolchains, headless)');
  check(rB.config.mappings.some((m) => m.host === f.shared && !m.readOnly) && rB.scripts.includes(path.join(f.workB, 'setup.mjs')), 'relative paths resolve against the folder of .sandbox-config.json');
  check((await f.run({ cwd: f.workB })).harnessName === 'codex' && (await f.run({ cwd: f.workB, noLocalConfig: true })).harnessName === 'claude' && (await f.run({ cwd: f.workB, harness: 'gemini' })).harnessName === 'gemini', 'approval is remembered; --no-local-config and --harness win');
  check((await f.run({ cwd: f.workB, headless: false })).config.sandbox.headless === false, '--window beats a local headless setting');
  f.writeLocal(f.workB, { ...localB, sandbox: { memoryMb: 6144 } });
  check(await rejects(() => f.run({ cwd: f.workB }), 'has not been approved'), 'changing the file requires approval again');

  const dirC = path.join(temp, 'work-c');
  ensureDir(dirC);
  const bad = async (content: unknown, needle: string): Promise<boolean> => { f.writeLocal(dirC, content); return rejects(() => f.run({ cwd: dirC, trustConfig: true }), needle); };
  check(await bad({ storage: { root: 'C:\\x' } }, 'storage is not allowed') && await bad({ harnesses: {} }, 'harnesses is not allowed'), 'local file cannot change storage or agent executables');
  check(await bad({ claudeProfile: { hostDir: 'C:\\x' } }, 'claudeProfile.hostDir is not allowed') && await bad({ toolchains: { node: { hostDir: 'x' } } }, 'toolchains.node.hostDir is not allowed'), 'local file cannot point at host folders');
  check(await bad({ sandbox: { memoryMb: 12 } }, 'sandbox.memoryMb:') && await bad({ mappings: [{ host: 'x', guest: 'C:\\Windows\\x', readOnly: true }] }, 'reserved or invalid guest path') && await bad({ provisioning: { git: { access: 'admin' } } }, 'provisioning.git.access:'), 'values are type-checked; reserved guest paths and unknown git modes are rejected');
  check(await bad('{\n  // a comment\n  "readOnly": tru\n}', 'line 3') && await bad({ _comment: 'old style' }, '_comment is not allowed'), 'broken JSON is reported with line and column; unknown keys are rejected');
  f.writeLocal(dirC, '// comments and trailing commas are fine\n{\n  "readOnly": true, /* inline */\n}\n');
  check((await f.run({ cwd: dirC, trustConfig: true })).config.readOnly === true, '.sandbox-config.json may contain comments and trailing commas');
  f.writeLocal(dirC, { claudeProfile: { copyCredentials: true }, network: { blockPrivateRanges: false }, provisioning: { git: { access: 'full' } } });
  check(await rejects(() => f.run({ cwd: dirC }), 'copies your Claude LOGIN') && await rejects(() => f.run({ cwd: dirC }), 'turns OFF the LAN block') && await rejects(() => f.run({ cwd: dirC }), 'commit and push'), 'risky settings are called out before approval');
  fs.rmSync(path.join(dirC, '.sandbox-config.json'));
};
