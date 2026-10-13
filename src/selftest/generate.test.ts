// What the host generates for a sandbox: the .wsb file, the launch folder (runtime, C# sources, boot scripts),
// session.json, the staged Claude profile, and the values read from this PC (git identity, free RAM).
import fs from 'node:fs';
import path from 'node:path';
import { LocalOverrides } from '../core/schema.js';
import { logonEnv } from '../host/generate.js';
import { gitIdentity } from '../host/launch/stage.js';
import { buildWsb, resolveMemoryMb } from '../host/launch/wsb.js';
import type { Suite } from './suite.js';

export const generateSuite: Suite = {
  name: 'generate',
  title: 'generated .wsb, launch folder and session.json',
  run: async (t, f) => {
    t.section('the .wsb file');
    const gen = await f.launch({}, { args: ['--version'], probe: { ...f.probe, gitDir: f.shared, nvmDir: f.workB } });
    const wsb = fs.readFileSync(gen.wsbPath, 'utf8');
    t.includes(wsb, '<MemoryInMB>8192</MemoryInMB>', 'wsb: the configured memory');
    t.includes(
      wsb,
      '<SandboxFolder>C:\\Workspace\\work-a</SandboxFolder>',
      'wsb: the workspace is mapped to its guest folder',
    );
    t.includes(wsb, 'C:\\HostTools\\git', "wsb: this PC's git is mapped");
    t.includes(wsb, 'C:\\HostTools\\nvm', "wsb: this PC's nvm is mapped");
    t.excludes(wsb, 'Missing', 'wsb: an optional mapping whose folder is missing is skipped');
    t.includes(wsb, 'logon.cmd</Command>', 'wsb: the logon command');
    t.includes(wsb, '<vGPU>Disable</vGPU>', 'wsb: vGPU is off');
    t.includes(
      buildWsb(f.baseConfig, 4096, [{ host: 'C:\\a&b', guest: 'C:\\X', readOnly: true }]),
      'C:\\a&amp;b',
      'wsb values are XML-escaped',
    );

    t.section('the launch folder');
    const expectedFiles = [
      'package.json',
      'runtime/main.js',
      'runtime/daemon.js',
      'runtime/view.js',
      'runtime/gitguard.js',
      'sandbox/bootstrap.ps1',
      'sandbox/logon.cmd',
      'sandbox/trust.cmd',
      'sandbox/ptyhost.cs',
      'sandbox/gitshim.cs',
      'sandbox/cpucap.ps1',
      'sandbox/cpucap.cs',
      'sandbox/pagefile.ps1',
      'sandbox/pagefile.cs',
      'sandbox/memlog.ps1',
    ];
    const missing = expectedFiles.filter((file) => !fs.existsSync(path.join(gen.launchPath, file)));
    t.equal(missing, [], 'the launch folder has the runtime, the C# sources and the boot scripts');
    t.equal(fs.readdirSync(path.join(gen.launchPath, 'runtime')).length, 6, 'the runtime is 6 self-contained files');
    const logon = fs.readFileSync(path.join(gen.launchPath, 'sandbox', 'logon.cmd'), 'utf8');
    t.check(
      logon.indexOf('trust.cmd') < logon.indexOf('wt.exe'),
      'logon.cmd applies the sandbox trust settings before opening Windows Terminal',
    );
    t.includes(logon, 'tools\\terminal\\wt.exe', 'logon.cmd opens Windows Terminal from the tools folder');
    t.includes(logon, '-NoExit', 'logon.cmd falls back to a PowerShell window');
    t.check(
      logon.indexOf('env.cmd') > 0 && logon.indexOf('env.cmd') < logon.indexOf('wt.exe'),
      'logon.cmd sets AGENT_WORKSPACE (env.cmd) before Windows Terminal starts, so new tabs can open in it',
    );
    t.includes(
      fs.readFileSync(path.join(gen.launchPath, 'env.cmd'), 'utf8'),
      'AGENT_WORKSPACE=',
      'env.cmd names the workspace',
    );
    t.equal(
      logonEnv('C:\\Workspace\\100%\\x'),
      '@set "AGENT_WORKSPACE=C:\\Workspace\\100%%\\x"\r\n',
      'a % in the workspace path is escaped for cmd',
    );

    t.section('session.json');
    const session = f.readJson(gen.sessionPath);
    t.equal(
      {
        launchId: session.launchId === gen.launchId,
        workspace: session.workspace,
        workspaceHost: session.workspaceHost,
        firstArgument: session.harnessArguments[0],
        gitFromHost: Boolean(session.hostTools.git),
        nvmFromHost: Boolean(session.hostTools.nvm),
        nodeSpec: session.versions.node.spec,
        gitAccess: session.provisioning.git.access,
      },
      {
        launchId: true,
        workspace: 'C:\\Workspace\\work-a',
        workspaceHost: f.workA,
        firstArgument: '--version',
        gitFromHost: true,
        nvmFromHost: true,
        nodeSpec: '22.3.0',
        gitAccess: 'full',
      },
      'session.json carries the id, paths, agent arguments, host tools, versions and git access',
    );
    t.matches(
      session.hostTools.nodeVersion ?? '',
      /^\d+\.\d+\.\d+$/,
      'session.json: the host Node version is a plain version',
    );
    t.equal(session.cpuLimitPercent, 80, 'session.json carries the CPU cap for cpucap.ps1 (default 80 %)');
    t.equal(session.pageFileMb, 16384, 'session.json carries the paging file limit for pagefile.ps1 (default 16 GB)');
    t.check(
      !LocalOverrides.safeParse({ sandbox: { cpuLimit: 'none' } }).success,
      "a project's .sandbox-config.json cannot lift your CPU cap (sandbox.cpuLimit is yours only)",
    );

    t.section('what is copied from this PC');
    const staged = path.join(gen.launchPath, 'claude-profile');
    const stagedMissing = ['settings.json', 'CLAUDE.md', '.claude.json', 'plugins'].filter(
      (name) => !fs.existsSync(path.join(staged, name)),
    );
    t.equal(stagedMissing, [], 'Claude settings, instructions, global state and plugins are staged');
    t.check(!fs.existsSync(path.join(staged, '.credentials.json')), 'the Claude login is not staged');
    const gitconfig =
      '[user]\n\tname = Josh\n\temail = "j@x.io"\n[credential]\n\thelper = store\n[url "https://TOKEN@github.com/"]\n\tinsteadOf = https://github.com/\n';
    t.equal(
      gitIdentity(gitconfig),
      '[user]\n\tname = Josh\n\temail = j@x.io\n',
      'only name/email from ~/.gitconfig reach the sandbox (no credential helpers or token URLs)',
    );
    t.equal(gitIdentity('[core]\n\tname = x\n'), '', 'a name outside [user] is not an identity');
    const auto = { ...f.baseConfig.sandbox, memoryMb: 'auto' as const };
    const MB = 1048576;
    const pcRam = 64 * 1024 * MB;
    t.equal(resolveMemoryMb(auto, 40000 * MB, pcRam), 31744, "memory 'auto' follows free RAM minus the reserve");
    await t.throws(
      () => resolveMemoryMb(auto, 9000 * MB, pcRam),
      'Not enough free RAM',
      "memory 'auto' refuses when too little RAM is free",
    );
    t.equal(
      resolveMemoryMb({ ...auto, maxMemoryPercent: 80 }, 30000 * MB, 32 * 1024 * MB),
      21504,
      "memory 'auto' never takes more than maxMemoryPercent of the PC's RAM",
    );
    t.equal(
      resolveMemoryMb({ ...auto, maxMemoryPercent: 50 }, 60000 * MB, pcRam),
      32768,
      "memory 'auto' is capped at half the PC's RAM with maxMemoryPercent 50 (free RAM and maxMemoryMb still apply)",
    );
  },
};
