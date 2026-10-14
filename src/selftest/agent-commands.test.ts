// Agent commands (Beta): which agents get a forwarding command, what the files contain, and that "off" changes nothing.
// Everything happens in the test's temp folder with a made-up PATH; your real PATH is never read or written.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../core/config/index.js';
import { agentCommands, commandsDir, realAgent } from '../host/agent-commands/index.js';
import { forwardingCmd, forwardingSh } from '../host/agent-commands/index.js';
import { reconcileAgentCommands } from '../host/agent-commands/index.js';
import type { Suite } from './support/suite.js';

export const agentCommandsSuite: Suite = {
  name: 'agent-commands',
  title: 'agent commands (Beta): claude, codex ... forwarded into a hidden sandbox',
  run: async (t) => {
    const storage = t.at('agent-cmd-storage');
    const npmDir = t.at('agent-cmd-npm');
    const localBin = t.at('agent-cmd-local');
    t.write(path.join(npmDir, 'codex.cmd'), '@echo codex');
    t.write(path.join(npmDir, 'gemini.cmd'), '@echo gemini');
    t.write(path.join(localBin, 'claude.exe'), 'MZ');
    // A forwarding file of our own, first on PATH, must never count as the real agent.
    t.write(path.join(commandsDir(storage), 'claude.cmd'), '@rem windows-development-sandbox agent command');
    const PATH = [commandsDir(storage), npmDir, localBin].join(path.delimiter);
    const on = { ...DEFAULTS, agentCommands: { enabled: true, agents: 'auto' as const } };

    t.section('finding agents');
    t.check(
      realAgent('claude', commandsDir(storage), PATH) === path.join(localBin, 'claude.exe') &&
        realAgent('nope', commandsDir(storage), PATH) === null,
      "the real agent is found on PATH, skipping this tool's own forwarding files; one not installed is not found",
    );
    const commandsOf = (config: typeof DEFAULTS, searchPath: string): string[] =>
      agentCommands(config, storage, searchPath)
        .map((a) => a.command)
        .sort();
    t.equal(
      commandsOf(on, PATH),
      ['claude', 'codex', 'gemini'],
      '"auto": every agent installed on this PC gets a command, agents not installed none',
    );
    t.equal(
      commandsOf({ ...on, agentCommands: { enabled: true, agents: ['codex'] } }, PATH),
      ['codex'],
      'a list limits it to the named agents',
    );
    const unsafeDir = t.at('agent%cmd^dir');
    t.write(path.join(unsafeDir, 'aider.cmd'), '@echo');
    t.check(
      !agentCommands(on, storage, unsafeDir).some((a) => a.command === 'aider'),
      'an agent in a folder whose path has % or ^ (which cmd.exe would expand) is left alone',
    );

    t.section('the forwarding files');
    const claude = { harness: 'claude', command: 'claude', real: path.join(localBin, 'claude.exe') };
    const cmd = forwardingCmd(claude, 'C:\\node\\node.exe', 'C:\\tool\\dist\\bin\\sandbox.js');
    t.check(
      cmd.includes(
        '"C:\\node\\node.exe" "C:\\tool\\dist\\bin\\sandbox.js" launch --harness claude --headless --terminal -- %*',
      ) &&
        cmd.includes('if "%SANDBOX_AGENT_DIRECT%"=="1" goto direct') &&
        cmd.includes('call "' + claude.real + '" %*'),
      'the .cmd starts the agent in a hidden sandbox attached to this terminal, unless SANDBOX_AGENT_DIRECT=1 (real agent)',
    );
    const sh = forwardingSh(
      { ...claude, real: "C:\\Users\\me\\it's\\claude.exe" },
      'C:\\node\\node.exe',
      'C:\\tool\\sandbox.js',
    );
    t.check(
      sh.startsWith('#!/bin/sh') &&
        sh.includes(
          "exec '/c/node/node.exe' '/c/tool/sandbox.js' launch --harness claude --headless --terminal -- \"$@\"",
        ) &&
        sh.includes("'/c/Users/me/it'\\''s/claude.exe'"),
      'Git Bash gets a shell script with POSIX paths, quoted safely',
    );

    t.section('off changes nothing');
    // Off with nothing set up: nothing to do, no PATH edit (which would be refused during the self-test anyway).
    const fresh = t.at('agent-cmd-fresh');
    const off = reconcileAgentCommands(DEFAULTS, fresh, 'C:\\node\\node.exe', 'C:\\tool\\sandbox.js');
    t.equal(
      { on: off.on, changed: off.changed, wrote: fs.existsSync(commandsDir(fresh)) },
      { on: false, changed: false, wrote: false },
      'off (the default) writes nothing and leaves your PATH alone',
    );
    await t.throws(
      () => reconcileAgentCommands(on, t.at('agent-cmd-on'), 'C:\\node\\node.exe', 'C:\\tool\\sandbox.js'),
      /self-test|PATH/i,
      'turning it on edits your PATH, which the self-test refuses (it never changes this PC)',
    );
  },
};
