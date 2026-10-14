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
    t.check(
      boot.status === 0 &&
        boot.out.includes('would run:') &&
        boot.out.includes('--version') &&
        boot.out.includes('cwd=' + f.workA),
      'the guest boots, exits cleanly and starts the agent with its arguments in the workspace',
      'exit code ' + boot.status + '\n' + boot.out,
    );
    const steps = [
      'would provision nvm and Node 22.3.0 (from this PC)',
      'would provision Python 3',
      'would provision MinGW-w64 GCC',
      'would provision Rust',
      '.NET SDK',
      'would provision bun',
      'would provision uv',
      'would provision Git for Windows from this PC',
    ];
    t.equal(
      steps.filter((s) => !boot.out.includes(s)),
      [],
      'the guest provisions every enabled toolchain',
    );
    t.check(
      boot.out.includes('AgentSandbox-Block-Private') &&
        boot.out.includes('remoteport=1-52,54-65535') &&
        readJsonFile<{ phase: string }>(path.join(data1, 'run', 'sandbox.json'))?.phase === 'ready',
      'the firewall plan blocks the LAN but keeps DNS to the gateway; the guest reports "ready"',
    );

    t.section('Claude state copied in');
    const claudeState = path.join(data1, 'state', 'claude');
    const plugins = fs.readFileSync(path.join(claudeState, 'plugins', 'installed_plugins.json'), 'utf8');
    t.check(
      fs.readFileSync(path.join(claudeState, 'settings.json'), 'utf8').includes('dark') &&
        fs.existsSync(path.join(claudeState, 'commands', 'review.md')) &&
        !fs.existsSync(path.join(claudeState, '.credentials.json')) &&
        plugins.includes(JSON.stringify(claudeState).slice(1, -1)),
      "this PC's Claude settings and commands are copied (not the login); plugin manifests point at the sandbox folder",
    );
    const guestState = f.readJson(path.join(claudeState, '.claude.json'));
    const manifest = fs.readFileSync(f.at('managed', 'CLAUDE.md'), 'utf8');
    t.check(
      guestState.mcpServers?.github?.command === 'npx' &&
        manifest.includes('DISPOSABLE Windows Sandbox') &&
        manifest.includes(f.workA) &&
        manifest.split('\n').length < 16 &&
        fs.readFileSync(path.join(claudeState, 'CLAUDE.md'), 'utf8') === 'my rules' &&
        fs.existsSync(path.join(data1, 'SANDBOX.md')) &&
        !fs.existsSync(f.at('managed', 'managed-settings.json')),
      "MCP servers come along; the short managed manifest names the workspace; the user's own CLAUDE.md is untouched; git access full has no deny rules",
    );

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
    const projectServers = Object.values(merged.projects as Record<string, { mcpServers?: Record<string, unknown> }>);
    t.check(
      merged.oauthAccount.emailAddress === 'sandbox@x' &&
        merged.mcpServers.github.command === 'npx2' &&
        merged.mcpServers.local.command === 'x' &&
        projectServers.some((p) => p.mcpServers?.db),
      'MCP re-sync leaves the sandbox login alone, updates changed servers, keeps ones added in the sandbox and brings in project servers',
      JSON.stringify(merged),
    );

    t.section('other modes');
    const readonlyConfig = f.makeConfig();
    readonlyConfig.provisioning.git.access = 'readonly';
    const genRo = await f.launch({}, { config: readonlyConfig });
    await f.runGuest(genRo.launchPath, t.at('data-ro'), f.workA, { AGENT_MANAGED_DIR: t.at('managed-ro') });
    const deny: string[] = f.readJson(t.at('managed-ro', 'managed-settings.json')).permissions.deny;
    t.check(
      deny.includes('Bash(git commit:*)') &&
        deny.includes('PowerShell(git push:*)') &&
        deny.includes('Edit(**/.git/**)') &&
        !deny.includes('Bash(git status:*)'),
      'git readonly: Claude managed settings deny writing git commands and .git edits, reading stays allowed',
      JSON.stringify(deny),
    );

    f.writeLocal(f.workB, { scripts: ['./setup.mjs'] });
    const genHook = await f.launch({ cwd: f.workB, harness: 'claude', trustConfig: true });
    const hook = await f.runGuest(genHook.launchPath, t.at('data-hook'), f.workB);
    t.check(
      hook.status === 0 && fs.readFileSync(t.at('data-hook', 'hook-ran.txt'), 'utf8') === f.workB,
      'local "scripts" run inside the sandbox with the workspace set',
      hook.out,
    );

    const genInstall = await f.launch(
      {},
      { config: f.makeConfig(false), probe: { ...f.probe, nodeDir: null, harnessExe: null } },
    );
    const install = await f.runGuest(genInstall.launchPath, t.at('data3'), f.workA, {
      AGENT_HOST_TOOLS_DIR: t.at('empty'),
    });
    t.check(
      install.status === 0 &&
        install.out.includes('npm-cli.js') &&
        install.out.includes('@anthropic-ai/claude-code') &&
        !fs.readFileSync(genInstall.wsbPath, 'utf8').includes('HostTools'),
      'install mode: npm installs the agent and nothing is mapped from this PC',
      install.out,
    );

    const genNoAgent = await f.launch({ noAgent: true });
    const noAgent = await f.runGuest(genNoAgent.launchPath, t.at('data5'), f.workA);
    t.check(
      noAgent.status === 0 && noAgent.out.includes('no agent requested'),
      '--no-agent provisions without an agent',
      noAgent.out,
    );
  },
};
