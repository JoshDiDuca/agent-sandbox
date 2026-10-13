// The guest's boot script (runtime/main.js) run in dry-run mode against fake sandbox folders: what it provisions,
// what it copies in, and what it refuses to.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from '../shared/io/index.js';
import type { Suite } from './support/suite.js';

export const guestBootSuite: Suite = {
  name: 'guest-boot',
  title: 'guest boot in dry-run mode (provisioning, Claude state, git policy)',
  run: async (t, f) => {
    // Bun and uv are "auto" by default; pinned on here so their steps are exercised.
    const pinned = f.makeConfig();
    pinned.toolchains.bun.enabled = true;
    pinned.toolchains.uv.enabled = true;
    const gen = await f.launch(
      {},
      { config: pinned, args: ['--version'], probe: { ...f.probe, gitDir: f.shared, nvmDir: f.workB } },
    );

    t.section('first boot');
    const data1 = t.at('data1');
    const boot = await f.runGuest(gen.launchPath, data1, f.workA, { AGENT_TEST_EXEMPT: '172.28.0.1' });
    t.check(boot.status === 0, 'the guest boots and exits cleanly', 'exit code ' + boot.status + '\n' + boot.out);
    t.includes(boot.out, 'would run:', 'the guest starts the agent...');
    t.includes(boot.out, '--version', '... with its arguments...');
    t.includes(boot.out, 'cwd=' + f.workA, '... in the workspace');
    for (const step of [
      'would provision nvm and Node 22.3.0 (from this PC)',
      'would provision Python 3',
      'would provision MinGW-w64 GCC',
      'would provision Rust',
      '.NET SDK',
      'would provision bun',
      'would provision uv',
      'would provision Git for Windows from this PC',
    ]) {
      t.includes(boot.out, step, 'the guest provisions: ' + step);
    }
    t.includes(boot.out, 'AgentSandbox-Block-Private', 'the firewall plan blocks the LAN...');
    t.includes(boot.out, 'remoteport=1-52,54-65535', '... but keeps DNS to the gateway');
    t.equal(
      readJsonFile<{ phase: string }>(path.join(data1, 'run', 'sandbox.json'))?.phase,
      'ready',
      'the guest reports "ready" in run/sandbox.json',
    );

    t.section('Claude state copied in');
    const claudeState = path.join(data1, 'state', 'claude');
    t.includes(
      fs.readFileSync(path.join(claudeState, 'settings.json'), 'utf8'),
      'dark',
      "the guest applied this PC's Claude settings",
    );
    t.check(fs.existsSync(path.join(claudeState, 'commands', 'review.md')), 'custom commands are copied');
    t.check(!fs.existsSync(path.join(claudeState, '.credentials.json')), 'the login is not copied');
    const plugins = fs.readFileSync(path.join(claudeState, 'plugins', 'installed_plugins.json'), 'utf8');
    t.includes(
      plugins,
      JSON.stringify(claudeState).slice(1, -1),
      'plugin manifests are re-pointed at the sandbox Claude folder',
    );
    const guestState = f.readJson(path.join(claudeState, '.claude.json'));
    t.equal(guestState.mcpServers?.github?.command, 'npx', 'MCP servers from this PC are in the sandbox');
    const manifest = fs.readFileSync(f.at('managed', 'CLAUDE.md'), 'utf8');
    t.includes(manifest, 'DISPOSABLE Windows Sandbox', 'the agent manifest goes to the managed CLAUDE.md...');
    t.includes(manifest, f.workA, '... naming the workspace');
    t.check(
      manifest.split('\n').length < 16,
      'the managed manifest stays tiny',
      manifest.split('\n').length + ' lines',
    );
    t.equal(
      fs.readFileSync(path.join(claudeState, 'CLAUDE.md'), 'utf8'),
      'my rules',
      "the user's own CLAUDE.md is untouched",
    );
    t.check(fs.existsSync(path.join(data1, 'SANDBOX.md')), 'SANDBOX.md is written to the data folder');
    t.check(!fs.existsSync(f.at('managed', 'managed-settings.json')), 'git access full: no managed deny rules');

    t.section('second boot');
    // The host changed its MCP servers: the sandbox keeps its own login and .claude.json but gets the new servers.
    fs.writeFileSync(
      path.join(claudeState, '.claude.json'),
      JSON.stringify({
        ...guestState,
        oauthAccount: { emailAddress: 'sandbox@x' },
        mcpServers: { local: { command: 'x' } },
      }),
    );
    t.writeJson(path.join(gen.launchPath, 'claude-profile', '.claude.json'), {
      mcpServers: { github: { command: 'npx2' } },
      projects: { [f.workA.replace(/\\/g, '/')]: { mcpServers: { db: { command: 'pg' } } } },
    });
    await f.runGuest(gen.launchPath, data1, f.workA);
    const merged = f.readJson(path.join(claudeState, '.claude.json'));
    t.equal(merged.oauthAccount.emailAddress, 'sandbox@x', 'MCP re-sync leaves the sandbox login alone');
    t.equal(merged.mcpServers.github.command, 'npx2', 'MCP re-sync updates a server changed on this PC');
    t.equal(merged.mcpServers.local.command, 'x', 'MCP re-sync keeps a server added in the sandbox');
    const projectServers = Object.values(merged.projects as Record<string, { mcpServers?: Record<string, unknown> }>);
    t.check(
      projectServers.some((p) => p.mcpServers?.db),
      'MCP re-sync brings in project-scope servers',
      JSON.stringify(merged.projects),
    );

    t.section('other modes');
    const readonlyConfig = f.makeConfig();
    readonlyConfig.provisioning.git.access = 'readonly';
    const genRo = await f.launch({}, { config: readonlyConfig });
    await f.runGuest(genRo.launchPath, t.at('data-ro'), f.workA, { AGENT_MANAGED_DIR: t.at('managed-ro') });
    const deny: string[] = f.readJson(t.at('managed-ro', 'managed-settings.json')).permissions.deny;
    t.check(
      deny.includes('Bash(git commit:*)') && deny.includes('PowerShell(git push:*)'),
      'git readonly: Claude managed settings deny writing git commands',
      JSON.stringify(deny),
    );
    t.check(deny.includes('Edit(**/.git/**)'), 'git readonly: .git edits are denied');
    t.check(!deny.includes('Bash(git status:*)'), 'git readonly: reading git commands stay allowed');

    f.writeLocal(f.workB, { scripts: ['./setup.mjs'] });
    const genHook = await f.launch({ cwd: f.workB, harness: 'claude', trustConfig: true });
    const hook = await f.runGuest(genHook.launchPath, t.at('data-hook'), f.workB);
    t.check(hook.status === 0, 'a project with "scripts" boots', hook.out);
    t.equal(
      fs.readFileSync(t.at('data-hook', 'hook-ran.txt'), 'utf8'),
      f.workB,
      'local "scripts" run inside the sandbox with the workspace set',
    );

    const genInstall = await f.launch(
      {},
      { config: f.makeConfig(false), probe: { ...f.probe, nodeDir: null, harnessExe: null } },
    );
    const install = await f.runGuest(genInstall.launchPath, t.at('data3'), f.workA, {
      AGENT_HOST_TOOLS_DIR: t.at('empty'),
    });
    t.check(install.status === 0, 'install mode boots', install.out);
    t.includes(install.out, 'npm-cli.js', 'install mode: npm is used...');
    t.includes(install.out, '@anthropic-ai/claude-code', '... to install the agent');
    t.excludes(
      fs.readFileSync(genInstall.wsbPath, 'utf8'),
      'HostTools',
      'install mode: nothing is mapped from this PC',
    );

    const genNoAgent = await f.launch({ noAgent: true });
    const noAgent = await f.runGuest(genNoAgent.launchPath, t.at('data5'), f.workA);
    t.check(noAgent.status === 0, '--no-agent boots', noAgent.out);
    t.includes(noAgent.out, 'no agent requested', '--no-agent provisions without an agent');
  },
};
